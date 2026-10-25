import { compressorCurve } from '../studio/dsp'

// Sample-by-sample dynamics for the mic processor: gate/expander, de-esser, compressor and
// look-ahead limiter. Pure TS so the same code runs in the AudioWorklet and in the tests.
// Every class processes a mono block in place and keeps its own state between blocks.

export const dbToLin = (db: number): number => Math.pow(10, db / 20)
export const linToDb = (g: number): number => (g > 1e-9 ? 20 * Math.log10(g) : -180)

/** One-pole smoothing coefficient for a time constant in ms */
export function coef(ms: number, sampleRate: number): number {
  return 1 - Math.exp(-1 / (Math.max(0.01, ms) / 1000 * sampleRate))
}

// ---- Gate / expander

export interface GateParams {
  on: boolean
  /** 'gate' drops to `rangeDb` when closed; 'expander' pushes quiet signals down by `ratio` */
  mode: 'gate' | 'expander'
  thresholdDb: number
  /** Closes this many dB below the threshold, so a voice hovering near it doesn't chatter */
  hysteresisDb: number
  /** Maximum attenuation, dB (negative) */
  rangeDb: number
  /** Expander ratio (1:ratio below the threshold) */
  ratio: number
  attackMs: number
  holdMs: number
  releaseMs: number
}

export class Gate {
  private env = 0
  private gainDb = 0
  private holdLeft = 0
  open = true
  /** Lowest gain applied in the last block, dB */
  blockGainDb = 0

  constructor(private sampleRate: number, private p: GateParams) {}

  set(p: GateParams): void {
    this.p = p
  }

  process(buf: Float32Array): void {
    const p = this.p
    if (!p.on) {
      this.open = true
      this.gainDb = 0
      this.blockGainDb = 0
      return
    }
    const sr = this.sampleRate
    const openLin = dbToLin(p.thresholdDb)
    const closeLin = dbToLin(p.thresholdDb - Math.max(0, p.hysteresisDb))
    const att = coef(p.attackMs, sr)
    const rel = coef(p.releaseMs, sr)
    const hold = (p.holdMs / 1000) * sr
    // Peak envelope: instant rise, ~10 ms fall
    const envDecay = Math.exp(-1 / (0.01 * sr))
    const range = Math.min(0, p.rangeDb)
    let lowest = 0
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i])
      this.env = a > this.env ? a : this.env * envDecay
      let target: number
      if (p.mode === 'expander') {
        const envDb = linToDb(this.env)
        if (envDb >= p.thresholdDb) {
          this.open = true
          this.holdLeft = hold
          target = 0
        } else if (this.holdLeft > 0) {
          this.holdLeft--
          target = 0
        } else {
          this.open = false
          target = Math.max(range, (envDb - p.thresholdDb) * (Math.max(1, p.ratio) - 1))
        }
      } else {
        if (this.env >= openLin || (this.open && this.env >= closeLin)) {
          this.open = true
          this.holdLeft = hold
        } else if (this.holdLeft > 0) {
          this.holdLeft--
        } else {
          this.open = false
        }
        target = this.open ? 0 : range
      }
      this.gainDb += (target - this.gainDb) * (target > this.gainDb ? att : rel)
      if (this.gainDb < lowest) lowest = this.gainDb
      buf[i] *= dbToLin(this.gainDb)
    }
    this.blockGainDb = lowest
  }
}

// ---- Compressor

export interface CompParams {
  on: boolean
  thresholdDb: number
  ratio: number
  kneeDb: number
  attackMs: number
  releaseMs: number
  makeupDb: number
  /** Parallel ("New York") compression: 0 = dry … 100 = fully compressed, % */
  mix: number
  /** Peak follows transients (control), RMS follows loudness (smoother levelling) */
  detector: 'peak' | 'rms'
}

export class Compressor {
  private grDb = 0
  private ms = 0
  /** Deepest gain reduction in the last block, dB (≤ 0) */
  blockGr = 0

  constructor(private sampleRate: number, private p: CompParams) {}

  set(p: CompParams): void {
    this.p = p
  }

  process(buf: Float32Array): void {
    const p = this.p
    if (!p.on) {
      this.grDb = 0
      this.blockGr = 0
      return
    }
    const att = coef(p.attackMs, this.sampleRate)
    const rel = coef(p.releaseMs, this.sampleRate)
    const rmsK = coef(10, this.sampleRate)
    const ratio = Math.max(1, p.ratio)
    const wet = Math.max(0, Math.min(100, p.mix)) / 100
    const makeup = dbToLin(p.makeupDb)
    let lowest = 0
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      let levelDb: number
      if (p.detector === 'rms') {
        this.ms += (x * x - this.ms) * rmsK
        // +3 dB so a sine reads its peak level, like the peak detector
        levelDb = linToDb(Math.sqrt(this.ms)) + 3.01
      } else {
        levelDb = linToDb(Math.abs(x))
      }
      const target = compressorCurve(levelDb, p.thresholdDb, ratio, Math.max(0, p.kneeDb)) - levelDb
      // More reduction = attack, less = release
      this.grDb += (target - this.grDb) * (target < this.grDb ? att : rel)
      if (this.grDb < lowest) lowest = this.grDb
      const y = x * dbToLin(this.grDb) * makeup
      buf[i] = wet >= 1 ? y : x * (1 - wet) + y * wet
    }
    this.blockGr = lowest
  }
}

// ---- De-esser

export interface DeEsserParams {
  on: boolean
  /** Centre of the sibilance band (and split point), Hz */
  freq: number
  thresholdDb: number
  /** Maximum reduction, dB (negative) */
  rangeDb: number
  /** 'split' only turns the highs down; 'wide' turns the whole signal down */
  mode: 'split' | 'wide'
  /** Outputs the detection band alone, to tune the frequency by ear */
  listen: boolean
}

export class DeEsser {
  private bp = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 }
  private lp = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 }
  private env = 0
  private grDb = 0
  private freq = 0
  blockGr = 0

  constructor(private sampleRate: number, private p: DeEsserParams) {
    this.design()
  }

  set(p: DeEsserParams): void {
    this.p = p
    if (p.freq !== this.freq) this.design()
  }

  private design(): void {
    const sr = this.sampleRate
    const f = Math.max(1000, Math.min(sr * 0.45, this.p.freq))
    this.freq = this.p.freq
    // Constant-skirt band-pass, Q 1.4: covers "s" and "sh" around the centre
    const w = (2 * Math.PI * f) / sr
    const alpha = Math.sin(w) / (2 * 1.4)
    const a0 = 1 + alpha
    Object.assign(this.bp, { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 })
    // Split: low = LP(x), high = x − low, so the bands always add back up exactly
    const wl = (2 * Math.PI * f * 0.6) / sr
    const al = Math.sin(wl) / (2 * Math.SQRT1_2)
    const cl = Math.cos(wl)
    const l0 = 1 + al
    Object.assign(this.lp, { b0: (1 - cl) / 2 / l0, b1: (1 - cl) / l0, b2: (1 - cl) / 2 / l0, a1: (-2 * cl) / l0, a2: (1 - al) / l0 })
  }

  process(buf: Float32Array): void {
    const p = this.p
    if (!p.on) {
      this.grDb = 0
      this.blockGr = 0
      return
    }
    const att = coef(0.5, this.sampleRate)
    const rel = coef(60, this.sampleRate)
    const envDecay = Math.exp(-1 / (0.02 * this.sampleRate))
    const range = Math.min(0, p.rangeDb)
    const f = this.bp
    const l = this.lp
    let lowest = 0
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      const s = f.b0 * x + f.z1
      f.z1 = f.b1 * x - f.a1 * s + f.z2
      f.z2 = f.b2 * x - f.a2 * s
      const a = Math.abs(s)
      this.env = a > this.env ? a : this.env * envDecay
      const over = linToDb(this.env) - p.thresholdDb
      // 4:1 above the threshold, down to the range
      const target = over > 0 ? Math.max(range, -over * 0.75) : 0
      this.grDb += (target - this.grDb) * (target < this.grDb ? att : rel)
      if (this.grDb < lowest) lowest = this.grDb
      const g = dbToLin(this.grDb)
      const low = l.b0 * x + l.z1
      l.z1 = l.b1 * x - l.a1 * low + l.z2
      l.z2 = l.b2 * x - l.a2 * low
      if (p.listen) buf[i] = s
      else if (p.mode === 'wide') buf[i] = x * g
      else buf[i] = low + (x - low) * g
    }
    this.blockGr = lowest
  }
}

// ---- Look-ahead limiter

export interface LimiterParams {
  on: boolean
  ceilingDb: number
  releaseMs: number
}

/** Look-ahead time: the limiter (and the dry path, for a clean bypass) is delayed by this much */
export const LOOKAHEAD_MS = 1.5

export function lookaheadSamples(sampleRate: number): number {
  return Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate))
}

export class Limiter {
  readonly latency: number
  private delay: Float32Array
  private gains: Float32Array
  private pos = 0
  private g = 1
  blockGr = 0

  constructor(private sampleRate: number, private p: LimiterParams) {
    this.latency = lookaheadSamples(sampleRate)
    this.delay = new Float32Array(this.latency)
    this.gains = new Float32Array(this.latency).fill(1)
  }

  set(p: LimiterParams): void {
    this.p = p
  }

  process(buf: Float32Array): void {
    const p = this.p
    const n = this.latency
    const ceil = dbToLin(Math.min(0, p.ceilingDb))
    // Reach the needed gain within the look-ahead window
    const att = 1 - Math.exp(-4 / n)
    const rel = coef(p.releaseMs, this.sampleRate)
    let lowest = 1
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      // The delay always runs, so latency doesn't change when the limiter is switched
      const out = this.delay[this.pos]
      this.delay[this.pos] = x
      const a = Math.abs(x)
      this.gains[this.pos] = a > ceil ? ceil / a : 1
      this.pos = (this.pos + 1) % n
      if (!p.on) {
        buf[i] = out
        continue
      }
      let need = 1
      for (let k = 0; k < n; k++) if (this.gains[k] < need) need = this.gains[k]
      this.g += (need - this.g) * (need < this.g ? att : rel)
      let y = out * this.g
      // Safety: nothing ever leaves above the ceiling
      if (y > ceil) y = ceil
      else if (y < -ceil) y = -ceil
      buf[i] = y
      if (this.g < lowest) lowest = this.g
    }
    this.blockGr = p.on ? linToDb(lowest) : 0
    if (!p.on) this.g = 1
  }
}
