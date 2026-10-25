// Small time-domain DSP toolkit for the studio: weighting filters (A, C, K),
// true-peak oversampling and test-signal generators. Pure TS, no Web Audio.

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Cascade of biquads in transposed direct form II (double precision state) */
export class FilterChain {
  private z1: Float64Array
  private z2: Float64Array

  constructor(readonly sections: Biquad[]) {
    this.z1 = new Float64Array(sections.length)
    this.z2 = new Float64Array(sections.length)
  }

  process(x: number): number {
    let v = x
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i]
      const y = s.b0 * v + this.z1[i]
      this.z1[i] = s.b1 * v - s.a1 * y + this.z2[i]
      this.z2[i] = s.b2 * v - s.a2 * y
      v = y
    }
    return v
  }

  reset(): void {
    this.z1.fill(0)
    this.z2.fill(0)
  }
}

/** Magnitude response of a biquad cascade at `f` Hz, in dB */
export function responseDb(sections: Biquad[], f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  let mag = 1
  for (const s of sections) {
    const nr = s.b0 + s.b1 * c1 + s.b2 * c2
    const ni = -(s.b1 * s1 + s.b2 * s2)
    const dr = 1 + s.a1 * c1 + s.a2 * c2
    const di = -(s.a1 * s1 + s.a2 * s2)
    mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di))
  }
  return 20 * Math.log10(mag)
}

/** Real analog pole at `hz` mapped through a pre-warped bilinear transform */
function digitalPole(hz: number, sampleRate: number): number {
  const wa = 2 * sampleRate * Math.tan((Math.PI * hz) / sampleRate)
  return (2 * sampleRate - wa) / (2 * sampleRate + wa)
}

function section(zerosAtDc: boolean, p1: number, p2: number): Biquad {
  return { b0: 1, b1: zerosAtDc ? -2 : 2, b2: 1, a1: -(p1 + p2), a2: p1 * p2 }
}

/** Scales the cascade so it reads 0 dB at 1 kHz, as the IEC 61672 curves require */
function normalizeAt1k(sections: Biquad[], sampleRate: number): Biquad[] {
  const g = Math.pow(10, -responseDb(sections, 1000, sampleRate) / 20)
  const [first, ...rest] = sections
  return [{ ...first, b0: first.b0 * g, b1: first.b1 * g, b2: first.b2 * g }, ...rest]
}

// IEC 61672 analog pole frequencies
const F1 = 20.598997
const F2 = 107.65265
const F3 = 737.86223
const F4 = 12194.217

/** A-weighting (perceived loudness of quiet sounds) as three biquads */
export function aWeighting(sampleRate: number): Biquad[] {
  const p1 = digitalPole(F1, sampleRate)
  const p2 = digitalPole(F2, sampleRate)
  const p3 = digitalPole(F3, sampleRate)
  const p4 = digitalPole(F4, sampleRate)
  return normalizeAt1k([section(true, p1, p1), section(true, p2, p3), section(false, p4, p4)], sampleRate)
}

/** C-weighting (nearly flat, used for peaks and loud sounds) as two biquads */
export function cWeighting(sampleRate: number): Biquad[] {
  const p1 = digitalPole(F1, sampleRate)
  const p4 = digitalPole(F4, sampleRate)
  return normalizeAt1k([section(true, p1, p1), section(false, p4, p4)], sampleRate)
}

/** ITU-R BS.1770 K-weighting: high-shelf pre-filter + RLB high-pass (libebur128 formulas) */
export function kWeighting(sampleRate: number): Biquad[] {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / sampleRate)
  a0 = 1 + K / Q + K * K
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  return [shelf, highpass]
}

/** Second-order Butterworth high-pass (RBJ cookbook), e.g. an 80 Hz low-cut */
export function highPass(hz: number, sampleRate: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * hz) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  const a0 = 1 + alpha
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

// ---- True peak (ITU-R BS.1770 annex 2): 4x oversampling with a windowed-sinc interpolator

const OVERSAMPLE = 4
const TAPS_PER_PHASE = 12

const POLYPHASE: Float64Array[] = (() => {
  const n = OVERSAMPLE * TAPS_PER_PHASE
  const h = new Float64Array(n)
  const mid = (n - 1) / 2
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / OVERSAMPLE
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n)
    h[i] = sinc * hann
  }
  const phases: Float64Array[] = []
  for (let k = 0; k < OVERSAMPLE; k++) {
    const p = new Float64Array(TAPS_PER_PHASE)
    let sum = 0
    for (let m = 0; m < TAPS_PER_PHASE; m++) {
      p[m] = h[k + OVERSAMPLE * m]
      sum += p[m]
    }
    // Unity DC gain per phase
    for (let m = 0; m < TAPS_PER_PHASE; m++) p[m] /= sum
    phases.push(p)
  }
  return phases
})()

/** Streaming true-peak detector: catches inter-sample peaks that clip a DAC */
export class TruePeakMeter {
  // Stored twice so the taps read a contiguous window without modulo
  private history = new Float64Array(TAPS_PER_PHASE * 2)
  private pos = 0
  max = 0

  push(samples: ArrayLike<number>): number {
    let blockMax = 0
    for (let i = 0; i < samples.length; i++) {
      this.history[this.pos] = samples[i]
      this.history[this.pos + TAPS_PER_PHASE] = samples[i]
      const newest = this.pos + TAPS_PER_PHASE
      for (let k = 0; k < OVERSAMPLE; k++) {
        const p = POLYPHASE[k]
        let acc = 0
        for (let m = 0; m < TAPS_PER_PHASE; m++) acc += p[m] * this.history[newest - m]
        const a = Math.abs(acc)
        if (a > blockMax) blockMax = a
      }
      // The sample itself is always a candidate
      const s = Math.abs(samples[i])
      if (s > blockMax) blockMax = s
      this.pos = (this.pos + 1) % TAPS_PER_PHASE
    }
    if (blockMax > this.max) this.max = blockMax
    return blockMax
  }

  reset(): void {
    this.history.fill(0)
    this.pos = 0
    this.max = 0
  }
}

export function ampToDb(a: number, floor = -100): number {
  return a > 0 ? Math.max(floor, 20 * Math.log10(a)) : floor
}

// ---- Test signals

/** Deterministic PRNG (mulberry32) so generated noise is reproducible in tests */
export function rng(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function whiteNoise(length: number, amplitude = 1, random = rng(7)): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = (random() * 2 - 1) * amplitude
  return out
}

/** Pink noise (−3 dB/octave) with Paul Kellet's refined filter; RMS ≈ amplitude/4 */
export function pinkNoise(length: number, amplitude = 1, random = rng(11)): Float32Array {
  const out = new Float32Array(length)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < length; i++) {
    const w = random() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
    out[i] = Math.max(-1, Math.min(1, pink * 0.11 * amplitude))
  }
  return out
}

/** Exponential (log) sine sweep from f0 to f1, with 10 ms fades to avoid clicks */
export function logSweep(sampleRate: number, f0: number, f1: number, seconds: number, amplitude = 1): Float32Array {
  const n = Math.round(sampleRate * seconds)
  const out = new Float32Array(n)
  const k = Math.log(f1 / f0)
  const fade = Math.round(sampleRate * 0.01)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const phase = ((2 * Math.PI * f0 * seconds) / k) * (Math.exp((t / seconds) * k) - 1)
    const env = Math.min(1, i / fade, (n - 1 - i) / fade)
    out[i] = Math.sin(phase) * amplitude * env
  }
  return out
}

/** Short windowed 2 kHz burst: sharp enough to time, gentle enough for speakers */
export function clickBurst(sampleRate: number, amplitude = 0.8): Float32Array {
  const n = Math.round(sampleRate * 0.004)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = Math.sin((2 * Math.PI * 2000 * i) / sampleRate) * hann * amplitude
  }
  return out
}

/**
 * Finds where `reference` appears in `recording` by normalized cross-correlation.
 * Returns the offset in samples and how clearly it stands out (0..1).
 */
export function findDelay(recording: Float32Array, reference: Float32Array, maxLag = recording.length - reference.length): { lag: number; confidence: number } {
  let refEnergy = 0
  for (let i = 0; i < reference.length; i++) refEnergy += reference[i] * reference[i]
  if (refEnergy === 0 || recording.length < reference.length) return { lag: 0, confidence: 0 }
  const last = Math.min(maxLag, recording.length - reference.length)
  let best = 0
  let bestLag = 0
  // Sliding energy of the recording window keeps the correlation normalized
  let winEnergy = 0
  for (let i = 0; i < reference.length; i++) winEnergy += recording[i] * recording[i]
  for (let lag = 0; lag <= last; lag++) {
    if (lag > 0) {
      const out = recording[lag - 1]
      const inn = recording[lag + reference.length - 1]
      winEnergy += inn * inn - out * out
    }
    if (winEnergy <= 1e-12) continue
    let acc = 0
    for (let i = 0; i < reference.length; i++) acc += recording[lag + i] * reference[i]
    const r = acc / Math.sqrt(refEnergy * winEnergy)
    if (r > best) {
      best = r
      bestLag = lag
    }
  }
  return { lag: bestLag, confidence: Math.max(0, Math.min(1, best)) }
}

/** Median and spread of repeated latency measurements (ms) */
export function summarizeLatency(values: number[]): { medianMs: number; minMs: number; maxMs: number; jitterMs: number } | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = v.length / 2
  const median = v.length % 2 ? v[Math.floor(mid)] : (v[mid - 1] + v[mid]) / 2
  const r = (x: number): number => Math.round(x * 10) / 10
  return { medianMs: r(median), minMs: r(v[0]), maxMs: r(v[v.length - 1]), jitterMs: r(v[v.length - 1] - v[0]) }
}

// ---- RBJ cookbook filters with the exact conventions of Web Audio's BiquadFilterNode,
// so curves drawn from these match what the mixer's nodes actually do.

function normalize(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Peaking EQ band (Q linear, as Web Audio's "peaking") */
export function peaking(hz: number, gainDb: number, q: number, sampleRate: number): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w = (2 * Math.PI * hz) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  return normalize(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A)
}

/** Low shelf with slope 1 (Web Audio's "lowshelf" ignores Q) */
export function lowShelf(hz: number, gainDb: number, sampleRate: number): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w = (2 * Math.PI * hz) / sampleRate
  const cos = Math.cos(w)
  const k = 2 * Math.sqrt(A) * (Math.sin(w) / 2) * Math.SQRT2
  return normalize(
    A * (A + 1 - (A - 1) * cos + k),
    2 * A * (A - 1 - (A + 1) * cos),
    A * (A + 1 - (A - 1) * cos - k),
    A + 1 + (A - 1) * cos + k,
    -2 * (A - 1 + (A + 1) * cos),
    A + 1 + (A - 1) * cos - k
  )
}

/** High shelf with slope 1 (Web Audio's "highshelf") */
export function highShelf(hz: number, gainDb: number, sampleRate: number): Biquad {
  const A = Math.pow(10, gainDb / 40)
  const w = (2 * Math.PI * hz) / sampleRate
  const cos = Math.cos(w)
  const k = 2 * Math.sqrt(A) * (Math.sin(w) / 2) * Math.SQRT2
  return normalize(
    A * (A + 1 + (A - 1) * cos + k),
    -2 * A * (A - 1 + (A + 1) * cos),
    A * (A + 1 + (A - 1) * cos - k),
    A + 1 - (A - 1) * cos + k,
    2 * (A - 1 - (A + 1) * cos),
    A + 1 - (A - 1) * cos - k
  )
}

/** Second-order low-pass (Q linear) */
export function lowPass(hz: number, sampleRate: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * hz) / sampleRate
  const alpha = Math.sin(w) / (2 * q)
  const cos = Math.cos(w)
  return normalize((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha)
}

/**
 * Static curve of a soft-knee compressor: output level for an input level (dB).
 * Same shape as DynamicsCompressorNode's knee, used to draw the transfer graph.
 */
export function compressorCurve(inDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
  const over = inDb - thresholdDb
  if (kneeDb > 0 && Math.abs(over) <= kneeDb / 2) {
    return inDb + ((1 / ratio - 1) * (over + kneeDb / 2) ** 2) / (2 * kneeDb)
  }
  return over <= 0 ? inDb : thresholdDb + over / ratio
}

/**
 * Makeup gain that Web Audio's DynamicsCompressorNode adds on its own
 * (spec: (1 / full-range gain)^0.6). The mixer subtracts it so makeup stays explicit.
 */
export function compressorAutoMakeupDb(thresholdDb: number, ratio: number, kneeDb: number): number {
  return -0.6 * compressorCurve(0, thresholdDb, ratio, kneeDb)
}
