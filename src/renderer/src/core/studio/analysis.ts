import { MIN_DB, type LevelReading } from '../audio/LevelAnalyzer'

// Pure measurement helpers for the studio mic comparator. No Web Audio here:
// the engine hands over readings, averaged power spectra and raw PCM.

/** ISO third-octave centers used for the frequency-response overlay */
export const BAND_CENTERS = [
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300,
  8000, 10000, 12500, 16000
]

export interface TakeMetrics {
  noiseFloorDb: number
  /** Mean RMS level over voiced frames (power average), dBFS */
  levelDb: number
  peakDb: number
  /** levelDb − noiseFloorDb */
  snrDb: number
  /** peak − level: high = dynamic/transient, low = compressed */
  crestDb: number
  clipCount: number
  /** Spectral centroid: higher = brighter sound */
  centroidHz: number
  /** Energy share per region (0..1): <250 Hz, 250 Hz–4 kHz, >4 kHz */
  bands: { low: number; mid: number; high: number }
  /** Third-octave response in dB, normalized so its power mean is 0 dB */
  curve: number[]
  durationS: number
  // Added later: older saved takes may not have them
  /** A-weighted noise floor (what the ear perceives as hiss/rumble), dBFS */
  noiseADb?: number
  /** Mains hum found in the silent part, null = clean */
  hum?: HumResult | null
  /** Mean sample value; |offset| > 0.01 means a faulty preamp/interface */
  dcOffset?: number
  /** Samples at or above full scale (exact, unlike the per-frame clipCount) */
  clippedSamples?: number
  /** Peak envelope of the take (0..1) for the waveform thumbnail */
  envelope?: number[]
}

export interface HumResult {
  /** Mains fundamental: 50 or 60 Hz */
  hz: number
  /** How far the hum harmonics stand above the surrounding noise */
  prominenceDb: number
}

export function dbToPower(db: number): number {
  return Math.pow(10, db / 10)
}

export function powerToDb(p: number): number {
  return p <= 0 ? MIN_DB : Math.max(MIN_DB, 10 * Math.log10(p))
}

export function binHz(bin: number, sampleRate: number, fftSize: number): number {
  return (bin * sampleRate) / fftSize
}

/** Power-weighted mean frequency of the spectrum (20 Hz – 20 kHz) */
export function spectralCentroid(power: ArrayLike<number>, sampleRate: number, fftSize: number): number {
  let num = 0
  let den = 0
  for (let i = 1; i < power.length; i++) {
    const f = binHz(i, sampleRate, fftSize)
    if (f < 20 || f > 20000) continue
    num += f * power[i]
    den += power[i]
  }
  return den > 0 ? num / den : 0
}

export function bandShares(power: ArrayLike<number>, sampleRate: number, fftSize: number): TakeMetrics['bands'] {
  let low = 0
  let mid = 0
  let high = 0
  for (let i = 1; i < power.length; i++) {
    const f = binHz(i, sampleRate, fftSize)
    if (f < 20 || f > 20000) continue
    if (f < 250) low += power[i]
    else if (f < 4000) mid += power[i]
    else high += power[i]
  }
  const total = low + mid + high
  if (total <= 0) return { low: 0, mid: 0, high: 0 }
  return { low: low / total, mid: mid / total, high: high / total }
}

/** Third-octave band levels, normalized to a 0 dB mean so mics of different gain overlay */
export function bandCurve(power: ArrayLike<number>, sampleRate: number, fftSize: number): number[] {
  const k = Math.pow(2, 1 / 6)
  const levels = BAND_CENTERS.map((fc) => {
    const lo = fc / k
    const hi = fc * k
    let sum = 0
    let n = 0
    for (let i = 1; i < power.length; i++) {
      const f = binHz(i, sampleRate, fftSize)
      if (f >= lo && f < hi) {
        sum += power[i]
        n++
      }
    }
    // Low bands may fall between bins: use the nearest bin
    if (n === 0) {
      const i = Math.min(power.length - 1, Math.max(1, Math.round((fc * fftSize) / sampleRate)))
      return power[i]
    }
    return sum / n
  })
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length
  return levels.map((p) => Math.round((powerToDb(p) - powerToDb(mean)) * 10) / 10)
}

/** IEC 61672 A-weighting gain at `f` Hz, in dB (0 dB at 1 kHz) */
export function aWeightingDb(f: number): number {
  if (f <= 0) return MIN_DB
  const f2 = f * f
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2))
  return 20 * Math.log10(ra) + 2.0
}

/** dB change in total power when the spectrum is A-weighted (add it to an unweighted level) */
export function aWeightingOffset(power: ArrayLike<number>, sampleRate: number, fftSize: number): number {
  let flat = 0
  let weighted = 0
  for (let i = 1; i < power.length; i++) {
    const f = binHz(i, sampleRate, fftSize)
    if (f < 20 || f > 20000) continue
    flat += power[i]
    weighted += power[i] * dbToPower(aWeightingDb(f))
  }
  return flat > 0 && weighted > 0 ? 10 * Math.log10(weighted / flat) : 0
}

/**
 * Looks for 50/60 Hz mains hum: the first harmonics must stand out from the
 * surrounding bins. Returns the stronger mains frequency when it's clearly audible.
 */
export function detectHum(power: ArrayLike<number>, sampleRate: number, fftSize: number, thresholdDb = 10): HumResult | null {
  const binOf = (f: number): number => Math.round((f * fftSize) / sampleRate)
  const prominence = (fundamental: number): number => {
    const values: number[] = []
    for (let k = 1; k <= 4; k++) {
      const c = binOf(fundamental * k)
      // Neighbours must sit between harmonics (spacing is only ~8–10 bins at 8192 FFT)
      const hzPerBin = sampleRate / fftSize
      const near = Math.max(3, Math.round((fundamental * 0.3) / hzPerBin))
      const far = Math.max(near + 1, Math.round((fundamental * 0.45) / hzPerBin))
      if (c - far < 1 || c + far >= power.length) continue
      const peak = Math.max(power[c - 1], power[c], power[c + 1])
      const around: number[] = []
      for (let d = near; d <= far; d++) around.push(power[c - d], power[c + d])
      around.sort((a, b) => a - b)
      const floor = (around[Math.floor((around.length - 1) / 2)] + around[Math.ceil((around.length - 1) / 2)]) / 2
      values.push(powerToDb(peak) - powerToDb(floor))
    }
    // The best two harmonics: speakers/cables often hum at 100/120 Hz more than at 50/60
    values.sort((a, b) => b - a)
    return values.length >= 2 ? (values[0] + values[1]) / 2 : 0
  }
  const p50 = prominence(50)
  const p60 = prominence(60)
  const [hz, db] = p50 >= p60 ? [50, p50] : [60, p60]
  return db >= thresholdDb ? { hz, prominenceDb: round1(db) } : null
}

/**
 * Strongest spectral peak (dB per bin), refined with parabolic interpolation.
 * Used live to name a feedback/ringing frequency. null when nothing stands out.
 */
export function dominantFrequency(
  db: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  minHz = 40,
  maxHz = 16000
): { hz: number; db: number } | null {
  let best = -1
  for (let i = 2; i < db.length - 1; i++) {
    const f = binHz(i, sampleRate, fftSize)
    if (f < minHz) continue
    if (f > maxHz) break
    if (best < 0 || db[i] > db[best]) best = i
  }
  if (best < 0 || db[best] <= -90) return null
  const a = db[best - 1]
  const b = db[best]
  const c = db[best + 1]
  const den = a - 2 * b + c
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0
  return { hz: Math.round(binHz(best + shift, sampleRate, fftSize)), db: round1(b - 0.25 * (a - c) * shift) }
}

/** Musical note nearest to `hz`, e.g. "A4", handy for tuning out feedback by ear */
export function noteName(hz: number): string {
  if (hz <= 0) return ''
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const midi = Math.round(69 + 12 * Math.log2(hz / 440))
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

/** Sample-accurate statistics of a take's raw PCM */
export function pcmStats(pcm: Float32Array): { dcOffset: number; clippedSamples: number; peakDb: number } {
  let sum = 0
  let clipped = 0
  let max = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]
    sum += v
    const a = Math.abs(v)
    if (a >= 0.999) clipped++
    if (a > max) max = a
  }
  return {
    dcOffset: pcm.length ? Math.round((sum / pcm.length) * 10000) / 10000 : 0,
    clippedSamples: clipped,
    peakDb: round1(max > 0 ? Math.max(MIN_DB, 20 * Math.log10(max)) : MIN_DB)
  }
}

/** Peak envelope in `buckets` slices, for waveform thumbnails */
export function envelope(pcm: Float32Array, buckets = 160): number[] {
  if (pcm.length === 0) return []
  const out: number[] = []
  const size = pcm.length / buckets
  for (let b = 0; b < buckets; b++) {
    let max = 0
    const end = Math.min(pcm.length, Math.floor((b + 1) * size))
    for (let i = Math.floor(b * size); i < end; i++) max = Math.max(max, Math.abs(pcm[i]))
    out.push(Math.round(max * 1000) / 1000)
  }
  return out
}

export function summarizeTake(input: {
  frames: LevelReading[]
  noiseFloorDb: number
  /** Linear power spectrum averaged over voiced frames */
  power: ArrayLike<number>
  sampleRate: number
  fftSize: number
  /** Frames this far above the floor count as signal */
  voicedMarginDb?: number
  /** Power spectrum of the silent pre-roll: enables A-weighted noise and hum detection */
  noisePower?: ArrayLike<number>
  /** Raw PCM: enables DC offset, exact clipping and the waveform envelope */
  pcm?: Float32Array
}): TakeMetrics {
  const { frames, noiseFloorDb, power, sampleRate, fftSize, noisePower, pcm } = input
  const margin = input.voicedMarginDb ?? 10
  const voiced = frames.filter((f) => f.rmsDb > noiseFloorDb + margin)
  const source = voiced.length > 0 ? voiced : frames
  const meanPower = source.reduce((a, f) => a + dbToPower(f.rmsDb), 0) / Math.max(1, source.length)
  const levelDb = powerToDb(meanPower)
  const peakDb = frames.reduce((m, f) => Math.max(m, f.peakDb), MIN_DB)
  const durationS = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0
  const metrics: TakeMetrics = {
    noiseFloorDb,
    levelDb: round1(levelDb),
    peakDb: round1(peakDb),
    snrDb: round1(levelDb - noiseFloorDb),
    crestDb: round1(peakDb - levelDb),
    clipCount: frames.filter((f) => f.clipped).length,
    centroidHz: Math.round(spectralCentroid(power, sampleRate, fftSize)),
    bands: bandShares(power, sampleRate, fftSize),
    curve: bandCurve(power, sampleRate, fftSize),
    durationS: round1(durationS)
  }
  if (noisePower) {
    metrics.noiseADb = round1(noiseFloorDb + aWeightingOffset(noisePower, sampleRate, fftSize))
    metrics.hum = detectHum(noisePower, sampleRate, fftSize)
  }
  if (pcm && pcm.length > 0) {
    const stats = pcmStats(pcm)
    metrics.dcOffset = stats.dcOffset
    metrics.clippedSamples = stats.clippedSamples
    // Sample peak is exact; the analyser frames can miss inter-frame peaks
    metrics.peakDb = Math.max(metrics.peakDb, stats.peakDb)
    metrics.crestDb = round1(metrics.peakDb - levelDb)
    metrics.envelope = envelope(pcm)
  }
  return metrics
}

export interface ScoreBreakdown {
  total: number
  snr: number
  level: number
  clipping: number
  balance: number
  notes: string[]
}

/**
 * Objective, approximate ranking. SNR dominates; level, clipping and tonal balance
 * adjust it. The blind listening test exists because "sounds better" is subjective.
 */
export function technicalScore(m: TakeMetrics): ScoreBreakdown {
  const notes: string[] = []
  const snr = clamp(m.snrDb / 45, 0, 1) * 55
  if (m.snrDb < 25) notes.push('Mucho ruido de fondo')

  // Healthy recording level: −30…−12 dBFS average
  const dist = m.levelDb < -30 ? -30 - m.levelDb : m.levelDb > -12 ? m.levelDb + 12 : 0
  const level = clamp(1 - dist / 18, 0, 1) * 15
  if (m.levelDb < -30) notes.push('Nivel bajo: sube la ganancia')
  if (m.levelDb > -12) notes.push('Nivel muy alto')

  const clipping = m.clipCount === 0 ? 15 : m.clipCount < 5 ? 7 : 0
  if (m.clipCount > 0) notes.push(`Saturó ${m.clipCount} veces`)
  else if (m.clippedSamples) notes.push(`${m.clippedSamples} muestras a 0 dBFS`)

  // Informational only (weights unchanged): these point at cabling/interface problems
  if (m.hum) notes.push(`Zumbido de ${m.hum.hz} Hz (+${m.hum.prominenceDb} dB): revisa tierra y cables`)
  if (m.dcOffset !== undefined && Math.abs(m.dcOffset) > 0.01) notes.push('DC offset: posible fallo del preamp o interfaz')

  // Speech/vocal balance: not boomy, with some presence/air
  let balance = 15
  if (m.bands.low > 0.45) {
    balance -= 7
    notes.push('Graves excesivos (efecto proximidad o zumbido)')
  }
  if (m.bands.high < 0.03) {
    balance -= 6
    notes.push('Poco brillo/agudos')
  }
  if (m.bands.high > 0.35) {
    balance -= 5
    notes.push('Agudos muy marcados (siseo)')
  }
  balance = Math.max(0, balance)

  return { total: Math.round(snr + level + clipping + balance), snr: Math.round(snr), level: Math.round(level), clipping, balance, notes }
}

/** RMS of raw PCM, used to loudness-match playback in A/B tests */
export function pcmRms(pcm: Float32Array): number {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0
}

/** Gain that brings `rms` to `targetRms`, capped so quiet noise isn't blasted */
export function matchGain(rms: number, targetRms: number, maxGain = 8): number {
  if (rms <= 0) return 1
  return Math.min(maxGain, targetRms / rms)
}

/** 16-bit PCM mono WAV */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buffer)
  const str = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
