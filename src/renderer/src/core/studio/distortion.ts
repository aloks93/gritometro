// Harmonic distortion of a test tone: THD (harmonics 2…10) and THD+N (everything that isn't
// the fundamental) over 20 Hz–20 kHz, from a Blackman-Harris windowed FFT.

/** In-place radix-2 FFT; `re`/`im` length must be a power of two */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** 4-term Blackman-Harris: −92 dB sidelobes, enough to see harmonics at 0.003 % */
function blackmanHarris(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1)
    w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
  }
  return w
}

/** Power spectrum (one-sided, arbitrary scale) of the last power-of-two block of `pcm` */
export function powerSpectrum(pcm: Float32Array, maxSize = 32768): { power: Float64Array; size: number } {
  let size = 1
  while (size * 2 <= Math.min(pcm.length, maxSize)) size *= 2
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const w = blackmanHarris(size)
  const off = pcm.length - size
  for (let i = 0; i < size; i++) re[i] = pcm[off + i] * w[i]
  fft(re, im)
  const power = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i]
  return { power, size }
}

export interface HarmonicLevel {
  k: number
  hz: number
  /** Relative to the fundamental, dB */
  dbc: number
}

export interface DistortionResult {
  fundamentalHz: number
  /** Fundamental level, dBFS (sine peak) */
  fundamentalDb: number
  thdPct: number
  thdDb: number
  thdnPct: number
  thdnDb: number
  /** Signal to noise and distortion = −THD+N in dB */
  sinadDb: number
  harmonics: HarmonicLevel[]
}

/** Bins each side of a peak that still belong to it (Blackman-Harris main lobe is ±4) */
const LOBE = 6

/**
 * THD and THD+N of a steady tone. `expectedHz` pins the fundamental (e.g. the generator's
 * frequency); otherwise the strongest bin above 20 Hz is used. null when there's no tone.
 */
export function measureDistortion(pcm: Float32Array, sampleRate: number, expectedHz?: number): DistortionResult | null {
  if (pcm.length < 4096) return null
  const { power, size } = powerSpectrum(pcm)
  const hzPerBin = sampleRate / size
  const lo = Math.max(1, Math.ceil(20 / hzPerBin))
  const hi = Math.min(power.length - 1, Math.floor(Math.min(20000, sampleRate / 2 - 1) / hzPerBin))
  let peak = lo
  if (expectedHz) {
    const c = Math.round(expectedHz / hzPerBin)
    for (let i = Math.max(lo, c - LOBE); i <= Math.min(hi, c + LOBE); i++) if (power[i] > power[peak] || peak < c - LOBE) peak = i
  } else {
    for (let i = lo; i <= hi; i++) if (power[i] > power[peak]) peak = i
  }
  const sumAround = (c: number): number => {
    let s = 0
    for (let i = Math.max(lo, c - LOBE); i <= Math.min(hi, c + LOBE); i++) s += power[i]
    return s
  }
  const fund = sumAround(peak)
  let total = 0
  for (let i = lo; i <= hi; i++) total += power[i]
  if (fund <= 0 || fund < total * 0.5) return null
  // Interpolated peak frequency (parabolic on log power)
  const a = Math.log(power[peak - 1] || 1e-30)
  const b = Math.log(power[peak] || 1e-30)
  const c = Math.log(power[peak + 1] || 1e-30)
  const delta = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0
  const f0 = (peak + delta) * hzPerBin
  const harmonics: HarmonicLevel[] = []
  let harm = 0
  for (let k = 2; k <= 10; k++) {
    const hz = f0 * k
    if (hz > 20000 || hz >= sampleRate / 2) break
    const p = sumAround(Math.round(hz / hzPerBin))
    harm += p
    harmonics.push({ k, hz: Math.round(hz), dbc: round1(10 * Math.log10(Math.max(p, 1e-30) / fund)) })
  }
  const thd = Math.sqrt(harm / fund)
  const thdn = Math.sqrt(Math.max(0, total - fund) / fund)
  // The lobe sum holds the tone's whole energy (Parseval): Σ|X|² = N·Σw²·A²/4, so a
  // full-scale sine reads 0 dBFS
  let w2 = 0
  const w = blackmanHarris(size)
  for (let i = 0; i < size; i++) w2 += w[i] * w[i]
  const amp = 2 * Math.sqrt(fund / (size * w2))
  const dbOf = (r: number): number => round1(20 * Math.log10(Math.max(r, 1e-10)))
  return {
    fundamentalHz: Math.round(f0 * 10) / 10,
    fundamentalDb: dbOf(amp),
    thdPct: round4(thd * 100),
    thdDb: dbOf(thd),
    thdnPct: round4(thdn * 100),
    thdnDb: dbOf(thdn),
    sinadDb: -dbOf(thdn),
    harmonics
  }
}

/** Plain-language reading of a THD+N value */
export function distortionVerdict(thdnPct: number): string {
  if (thdnPct < 0.01) return 'Excelente: nivel de interfaz de estudio.'
  if (thdnPct < 0.1) return 'Muy buena: limpia para grabar y medir.'
  if (thdnPct < 1) return 'Aceptable: distorsión audible solo en tonos puros.'
  if (thdnPct < 5) return 'Alta: revisa la ganancia (puede estar saturando) o el altavoz.'
  return 'Muy alta: hay saturación o la cadena está mal ajustada.'
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}
