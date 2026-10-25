import { fft } from './distortion'

// Two-channel analysis: phase correlation, balance, and the time/polarity offset between
// channels (two mics on one source, or the L/R of a stereo bus).

/** Zero-lag correlation −1…+1 (what a console's phase meter shows); 0 when either is silent */
export function phaseCorrelation(l: ArrayLike<number>, r: ArrayLike<number>): number {
  let lr = 0
  let ll = 0
  let rr = 0
  const n = Math.min(l.length, r.length)
  for (let i = 0; i < n; i++) {
    lr += l[i] * r[i]
    ll += l[i] * l[i]
    rr += r[i] * r[i]
  }
  const d = Math.sqrt(ll * rr)
  return d > 1e-12 ? Math.max(-1, Math.min(1, lr / d)) : 0
}

/** Level difference R − L in dB (positive = right louder); 0 when silent */
export function balanceDb(l: ArrayLike<number>, r: ArrayLike<number>): number {
  let ll = 0
  let rr = 0
  const n = Math.min(l.length, r.length)
  for (let i = 0; i < n; i++) {
    ll += l[i] * l[i]
    rr += r[i] * r[i]
  }
  if (ll < 1e-12 && rr < 1e-12) return 0
  return Math.round(10 * Math.log10(Math.max(rr, 1e-12) / Math.max(ll, 1e-12)) * 10) / 10
}

export interface ChannelOffset {
  /** Samples `b` lags behind `a` (negative = `b` arrives first) */
  lag: number
  ms: number
  /** Normalized correlation at that lag; negative = one channel has inverted polarity */
  correlation: number
  inverted: boolean
}

/**
 * Finds the lag (within ±maxLag samples) where `b` best matches `a`, by FFT
 * cross-correlation. Polarity counts: a strong negative peak means "inverted".
 */
export function channelOffset(a: ArrayLike<number>, b: ArrayLike<number>, sampleRate: number, maxLag: number): ChannelOffset | null {
  const n = Math.min(a.length, b.length)
  let size = 1
  while (size < n * 2) size *= 2
  const ar = new Float64Array(size)
  const ai = new Float64Array(size)
  const br = new Float64Array(size)
  const bi = new Float64Array(size)
  let ea = 0
  let eb = 0
  for (let i = 0; i < n; i++) {
    ar[i] = a[i]
    br[i] = b[i]
    ea += a[i] * a[i]
    eb += b[i] * b[i]
  }
  if (ea < 1e-9 || eb < 1e-9) return null
  fft(ar, ai)
  fft(br, bi)
  // conj(A)·B → inverse FFT (as a forward FFT of the conjugate) gives the cross-correlation
  for (let i = 0; i < size; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i]
    const im = ar[i] * bi[i] - ai[i] * br[i]
    ar[i] = re
    ai[i] = -im
  }
  fft(ar, ai)
  const norm = Math.sqrt(ea * eb)
  let best = 0
  let bestV = 0
  const lim = Math.min(maxLag, n - 1)
  for (let lag = -lim; lag <= lim; lag++) {
    const v = ar[(lag + size) % size] / size / norm
    if (Math.abs(v) > Math.abs(bestV)) {
      bestV = v
      best = lag
    }
  }
  return { lag: best, ms: Math.round((best / sampleRate) * 100000) / 100, correlation: Math.round(bestV * 1000) / 1000, inverted: bestV < 0 }
}

/** Mid/side goniometer coordinates (x = side, y = mid), each in −1…1 for full-scale input */
export function goniometer(l: ArrayLike<number>, r: ArrayLike<number>, out: Float32Array): number {
  const n = Math.min(l.length, r.length, out.length / 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = (r[i] - l[i]) * Math.SQRT1_2
    out[i * 2 + 1] = (l[i] + r[i]) * Math.SQRT1_2
  }
  return n
}

/** What a sound engineer would say about a correlation reading */
export function correlationVerdict(c: number): string {
  if (c > 0.9) return 'Casi mono: los dos canales son prácticamente iguales.'
  if (c > 0.3) return 'Estéreo sano: compatible con mono.'
  if (c > -0.1) return 'Muy ancho o descorrelado: comprueba cómo suena en mono.'
  return 'Fase invertida: en mono se cancela. Pulsa Ø en uno de los canales o revisa el cableado.'
}

/** Distance difference between two mics from their time offset (speed of sound 343 m/s) */
export function offsetToCm(ms: number): number {
  return Math.round(Math.abs(ms) * 34.3 * 10) / 10
}
