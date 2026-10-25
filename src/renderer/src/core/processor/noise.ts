import { fft } from '../studio/distortion'

// Spectral noise reduction for the mic processor (pure TS, runs in the AudioWorklet).
// STFT with a Hann window and 75 % overlap; per-bin noise estimate either learned from a few
// seconds of silence or tracked continuously (minimum statistics); Wiener gain with the
// decision-directed a-priori SNR (Ephraim–Malah), which keeps "musical noise" low.

export type NoiseResolution = 512 | 1024 | 2048

export interface NoiseParams {
  on: boolean
  /** 'learned' uses the captured profile (falls back to adaptive until one exists) */
  mode: 'adaptive' | 'learned'
  /** Maximum attenuation of noise, dB (negative) */
  reductionDb: number
  /** Raises (+) or lowers (−) the noise estimate: more or less aggressive, dB */
  sensitivityDb: number
  /** Temporal smoothing of the gains, 0…100 % (higher = smoother, fewer artefacts, slower) */
  smoothing: number
  /** Reduction above this frequency only (keeps the low body untouched), Hz; 0 = full band */
  fromHz: number
  /** FFT size: more = finer frequency resolution, more latency */
  resolution: NoiseResolution
  /** Outputs what is being removed, to check that no voice goes with it */
  listenRemoved: boolean
  /** Learned profile: noise power per bin (any length, resampled to the FFT size), null = none */
  profile: number[] | null
}

/** Latency added by the suppressor (one frame), in samples */
export function noiseLatency(resolution: NoiseResolution): number {
  return resolution
}

/** Linearly resamples a per-bin profile to `bins` bins (the FFT size may have changed) */
export function resampleProfile(profile: ArrayLike<number>, bins: number): Float64Array {
  const out = new Float64Array(bins)
  const n = profile.length
  if (n === 0) return out
  for (let k = 0; k < bins; k++) {
    const x = (k / Math.max(1, bins - 1)) * (n - 1)
    const i = Math.floor(x)
    const f = x - i
    out[k] = profile[i] * (1 - f) + (profile[Math.min(n - 1, i + 1)] ?? 0) * f
  }
  return out
}

export class NoiseSuppressor {
  readonly n: number
  readonly hop: number
  readonly bins: number
  readonly latency: number
  private win: Float64Array
  private inBuf: Float64Array
  private outBuf: Float64Array
  private fill = 0
  private outPos = 0
  private re: Float64Array
  private im: Float64Array
  private smooth: Float64Array
  private tracked: Float64Array
  private learned: Float64Array | null = null
  private prevClean: Float64Array
  private gainPrev: Float64Array
  /** Current gain per bin (0…1), for display */
  readonly gains: Float64Array
  /** Noise estimate in use per bin (power), for display */
  readonly noise: Float64Array
  /** Input power per bin of the last frame, for display */
  readonly power: Float64Array
  private learnLeft = 0
  private learnSum: Float64Array | null = null
  private learnFrames = 0
  private frames = 0
  /** Average reduction of the last frame, dB (≤ 0) */
  reductionDb = 0
  /** Set when a learning run finishes; read and clear it to store the profile */
  learnedProfile: Float64Array | null = null

  constructor(private sampleRate: number, private p: NoiseParams) {
    this.n = p.resolution
    this.hop = this.n / 4
    this.bins = this.n / 2 + 1
    this.latency = this.n
    this.win = new Float64Array(this.n)
    for (let i = 0; i < this.n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.n)
    this.inBuf = new Float64Array(this.n)
    this.outBuf = new Float64Array(this.n * 2)
    // Output lags one frame: the first hop of output is read `n` samples after it was written
    this.fill = 0
    this.outPos = 0
    this.re = new Float64Array(this.n)
    this.im = new Float64Array(this.n)
    this.smooth = new Float64Array(this.bins)
    this.tracked = new Float64Array(this.bins)
    this.prevClean = new Float64Array(this.bins)
    this.gainPrev = new Float64Array(this.bins).fill(1)
    this.gains = new Float64Array(this.bins).fill(1)
    this.noise = new Float64Array(this.bins)
    this.power = new Float64Array(this.bins)
    this.set(p)
  }

  set(p: NoiseParams): void {
    this.p = p
    this.learned = p.profile && p.profile.length > 1 ? resampleProfile(p.profile, this.bins) : null
  }

  /** Starts capturing the noise profile for `seconds` (stay silent meanwhile) */
  learn(seconds: number): void {
    this.learnLeft = Math.max(1, Math.round((seconds * this.sampleRate) / this.hop))
    this.learnSum = new Float64Array(this.bins)
    this.learnFrames = 0
  }

  get learning(): boolean {
    return this.learnLeft > 0
  }

  process(buf: Float32Array): void {
    const n = this.n
    const h = this.hop
    for (let i = 0; i < buf.length; i++) {
      this.inBuf[this.fill] = buf[i]
      buf[i] = this.outBuf[this.outPos]
      this.outBuf[this.outPos] = 0
      this.outPos++
      this.fill++
      if (this.fill === n) {
        this.frame()
        // Slide the input by one hop
        this.inBuf.copyWithin(0, h)
        this.fill = n - h
      }
      if (this.outPos === h) {
        // Slide the output: the next hop to read moves to the front
        this.outBuf.copyWithin(0, h)
        this.outBuf.fill(0, this.outBuf.length - h)
        this.outPos = 0
      }
    }
  }

  private frame(): void {
    const n = this.n
    const bins = this.bins
    const p = this.p
    const re = this.re
    const im = this.im
    for (let i = 0; i < n; i++) {
      re[i] = this.inBuf[i] * this.win[i]
      im[i] = 0
    }
    fft(re, im)
    this.frames++
    // Minimum-statistics tracker: follows the floor, rises ~3 dB/s when the floor rises
    const rise = Math.pow(10, (3 * this.hop) / this.sampleRate / 10)
    for (let k = 0; k < bins; k++) {
      const pw = re[k] * re[k] + im[k] * im[k]
      this.power[k] = pw
      this.smooth[k] = this.frames === 1 ? pw : this.smooth[k] * 0.85 + pw * 0.15
      const t = this.tracked[k]
      this.tracked[k] = this.frames === 1 || this.smooth[k] < t ? this.smooth[k] : t * rise
    }
    if (this.learnLeft > 0 && this.learnSum) {
      for (let k = 0; k < bins; k++) this.learnSum[k] += this.power[k]
      this.learnFrames++
      if (--this.learnLeft === 0) {
        const prof = new Float64Array(bins)
        for (let k = 0; k < bins; k++) prof[k] = this.learnSum[k] / this.learnFrames
        this.learned = prof
        this.learnedProfile = prof
        this.learnSum = null
      }
    }

    const floor = Math.pow(10, Math.min(0, p.reductionDb) / 20)
    const over = Math.pow(10, p.sensitivityDb / 10)
    // Decision-directed weight: 0.9 (responsive) … 0.995 (very smooth)
    const alpha = 0.9 + (Math.max(0, Math.min(100, p.smoothing)) / 100) * 0.095
    const fromBin = Math.max(0, Math.floor((p.fromHz / this.sampleRate) * n))
    const useLearned = p.mode === 'learned' && this.learned !== null
    let inSum = 0
    let outSum = 0
    for (let k = 0; k < bins; k++) {
      // The tracked minimum sits below the mean noise power: ×2 compensates its bias
      const nz = (useLearned ? this.learned![k] : this.tracked[k] * 2) * over + 1e-20
      this.noise[k] = nz
      let g = 1
      if (p.on && k >= fromBin) {
        const post = this.power[k] / nz
        const prio = alpha * (this.prevClean[k] / nz) + (1 - alpha) * Math.max(post - 1, 0)
        g = Math.max(floor, prio / (1 + prio))
      }
      this.gains[k] = g
    }
    // Light smoothing across frequency against isolated "chirps"
    let prev = this.gains[0]
    for (let k = 1; k < bins - 1; k++) {
      const cur = this.gains[k]
      this.gains[k] = Math.max(floor, (prev + 2 * cur + this.gains[k + 1]) / 4)
      prev = cur
    }
    for (let k = 0; k < bins; k++) {
      const g = this.gains[k]
      this.prevClean[k] = g * g * this.power[k]
      this.gainPrev[k] = g
      inSum += this.power[k]
      outSum += g * g * this.power[k]
      // Mirror onto the negative frequencies so the inverse FFT stays real
      const m = p.on && p.listenRemoved ? 1 - g : g
      re[k] *= m
      im[k] *= m
      if (k > 0 && k < n / 2) {
        re[n - k] *= m
        im[n - k] *= m
      }
    }
    this.reductionDb = inSum > 1e-12 ? Math.min(0, 10 * Math.log10(outSum / inSum)) : 0
    // Inverse FFT via conjugation
    for (let i = 0; i < n; i++) im[i] = -im[i]
    fft(re, im)
    // Hann analysis × Hann synthesis at 75 % overlap sums to 1.5
    const scale = 1 / (n * 1.5)
    const base = this.outPos
    for (let i = 0; i < n; i++) this.outBuf[base + i] += re[i] * this.win[i] * scale
  }
}
