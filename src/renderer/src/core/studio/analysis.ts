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

export function summarizeTake(input: {
  frames: LevelReading[]
  noiseFloorDb: number
  /** Linear power spectrum averaged over voiced frames */
  power: ArrayLike<number>
  sampleRate: number
  fftSize: number
  /** Frames this far above the floor count as signal */
  voicedMarginDb?: number
}): TakeMetrics {
  const { frames, noiseFloorDb, power, sampleRate, fftSize } = input
  const margin = input.voicedMarginDb ?? 10
  const voiced = frames.filter((f) => f.rmsDb > noiseFloorDb + margin)
  const source = voiced.length > 0 ? voiced : frames
  const meanPower = source.reduce((a, f) => a + dbToPower(f.rmsDb), 0) / Math.max(1, source.length)
  const levelDb = powerToDb(meanPower)
  const peakDb = frames.reduce((m, f) => Math.max(m, f.peakDb), MIN_DB)
  const durationS = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0
  return {
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
