import { compressorCurve, OVERSAMPLE, POLYPHASE, TAPS_PER_PHASE } from '../studio/dsp'

// Sample-by-sample dynamics for the mic processor: gate/expander, de-esser, compressor,
// saturation and look-ahead limiter. Pure TS so the same code runs in the AudioWorklet and in
// the tests. Every class processes a mono block in place and keeps its own state between blocks.
// Knob moves and on/off switches glide (Smoother), so nothing clicks while adjusting live.

export const dbToLin = (db: number): number => Math.pow(10, db / 20)
export const linToDb = (g: number): number => (g > 1e-9 ? 20 * Math.log10(g) : -180)

/** One-pole smoothing coefficient for a time constant in ms */
export function coef(ms: number, sampleRate: number): number {
  return 1 - Math.exp(-1 / (Math.max(0.01, ms) / 1000 * sampleRate))
}

/** Values this small are set to 0: denormals make the CPU crawl after a few seconds of silence */
export const DENORMAL = 1e-25

/**
 * One-pole parameter glide (~20 ms). It starts at the first target, so a fresh processor
 * sounds exactly like the static settings, and snaps once it is close enough.
 */
export class Smoother {
  v = NaN
  private k: number

  constructor(sampleRate: number, ms = 20) {
    this.k = coef(ms, sampleRate)
  }

  next(target: number): number {
    if (this.v !== this.v) this.v = target
    else if (this.v !== target) {
      this.v += (target - this.v) * this.k
      if (Math.abs(target - this.v) < 1e-5) this.v = target
    }
    return this.v
  }

  /** Resting at `target` (a smoother that never ran starts there) */
  settled(target: number): boolean {
    if (this.v !== this.v) this.v = target
    return this.v === target
  }
}

/** Second-order section (RBJ cookbook) with its own state, for detector/sidechain filters */
export class Section {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private z1 = 0
  private z2 = 0
  active = false

  constructor(private sampleRate: number) {}

  /** hz ≤ 0 switches the section off (pass-through) */
  design(type: 'highpass' | 'lowpass' | 'bandpass', hz: number, q = Math.SQRT1_2): void {
    const sr = this.sampleRate
    this.active = hz > 0 && hz < sr * 0.49
    if (!this.active) return
    const w = (2 * Math.PI * hz) / sr
    const cos = Math.cos(w)
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    if (type === 'bandpass') {
      this.b0 = alpha / a0
      this.b1 = 0
      this.b2 = -alpha / a0
    } else {
      const lp = type === 'lowpass'
      this.b0 = (lp ? (1 - cos) / 2 : (1 + cos) / 2) / a0
      this.b1 = (lp ? 1 - cos : -(1 + cos)) / a0
      this.b2 = this.b0
    }
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number): number {
    if (!this.active) return x
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  /** Clears denormal state; call once per block */
  flush(): void {
    if (Math.abs(this.z1) < DENORMAL) this.z1 = 0
    if (Math.abs(this.z2) < DENORMAL) this.z2 = 0
  }
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
  /** Detector filters: rumble (HPF) and hiss (LPF) don't open the gate. 0 = off */
  keyHpfHz: number
  keyLpfHz: number
}

export class Gate {
  private env = 0
  private gainDb = 0
  private holdLeft = 0
  private hpf: Section
  private lpf: Section
  private key = ''
  private amt: Smoother
  open = true
  /** Lowest gain applied in the last block, dB */
  blockGainDb = 0
  /** Highest detector level in the last block, dB */
  blockLevelDb = -100

  constructor(private sampleRate: number, private p: GateParams) {
    this.hpf = new Section(sampleRate)
    this.lpf = new Section(sampleRate)
    this.amt = new Smoother(sampleRate)
    this.set(p)
  }

  set(p: GateParams): void {
    this.p = p
    const key = `${p.keyHpfHz}|${p.keyLpfHz}`
    if (key === this.key) return
    this.key = key
    this.hpf.design('highpass', p.keyHpfHz ?? 0)
    this.lpf.design('lowpass', p.keyLpfHz ?? 0)
  }

  process(buf: Float32Array): void {
    const p = this.p
    const sr = this.sampleRate
    // Peak envelope: instant rise, ~10 ms fall
    const envDecay = Math.exp(-1 / (0.01 * sr))
    let level = 0
    if (!p.on && this.amt.settled(0)) {
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(this.lpf.process(this.hpf.process(buf[i])))
        this.env = a > this.env ? a : this.env * envDecay
        if (this.env > level) level = this.env
      }
      this.open = true
      this.gainDb = 0
      this.blockGainDb = 0
      this.blockLevelDb = linToDb(level)
      this.flush()
      return
    }
    const openLin = dbToLin(p.thresholdDb)
    const closeLin = dbToLin(p.thresholdDb - Math.max(0, p.hysteresisDb))
    const att = coef(p.attackMs, sr)
    const rel = coef(p.releaseMs, sr)
    const hold = (p.holdMs / 1000) * sr
    const range = Math.min(0, p.rangeDb)
    let lowest = 0
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(this.lpf.process(this.hpf.process(buf[i])))
      this.env = a > this.env ? a : this.env * envDecay
      if (this.env > level) level = this.env
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
      // Switching the gate on/off fades its action in/out instead of jumping
      const g = this.gainDb * this.amt.next(p.on ? 1 : 0)
      if (g < lowest) lowest = g
      buf[i] *= dbToLin(g)
    }
    this.blockGainDb = lowest
    this.blockLevelDb = linToDb(level)
    this.flush()
  }

  private flush(): void {
    this.hpf.flush()
    this.lpf.flush()
    if (this.env < DENORMAL) this.env = 0
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
  /** Adds the gain the static curve takes away at −18 dBFS (a typical voice), on top of makeupDb */
  autoMakeup: boolean
  /** Parallel ("New York") compression: 0 = dry … 100 = fully compressed, % */
  mix: number
  /** Peak follows transients (control), RMS follows loudness (smoother levelling) */
  detector: 'peak' | 'rms'
  /** Sidechain high-pass: plosives and low end don't pump the voice. 0 = off */
  scHpfHz: number
}

/** Makeup added by `autoMakeup` */
export function autoMakeupDb(p: Pick<CompParams, 'thresholdDb' | 'ratio' | 'kneeDb'>): number {
  const ref = -18
  return Math.max(0, ref - compressorCurve(ref, p.thresholdDb, Math.max(1, p.ratio), Math.max(0, p.kneeDb)))
}

export class Compressor {
  private grDb = 0
  private ms = 0
  private sc: Section
  private scHz = -1
  private amt: Smoother
  private makeupSm: Smoother
  private wetSm: Smoother
  /** Deepest gain reduction in the last block, dB (≤ 0) */
  blockGr = 0
  /** Highest detector level in the last block, dB */
  blockLevelDb = -100

  constructor(private sampleRate: number, private p: CompParams) {
    this.sc = new Section(sampleRate)
    this.amt = new Smoother(sampleRate)
    this.makeupSm = new Smoother(sampleRate)
    this.wetSm = new Smoother(sampleRate)
    this.set(p)
  }

  set(p: CompParams): void {
    this.p = p
    if ((p.scHpfHz ?? 0) !== this.scHz) {
      this.scHz = p.scHpfHz ?? 0
      this.sc.design('highpass', this.scHz)
    }
  }

  process(buf: Float32Array): void {
    const p = this.p
    const att = coef(p.attackMs, this.sampleRate)
    const rel = coef(p.releaseMs, this.sampleRate)
    const rmsK = coef(10, this.sampleRate)
    const ratio = Math.max(1, p.ratio)
    const knee = Math.max(0, p.kneeDb)
    const wet = Math.max(0, Math.min(100, p.mix)) / 100
    const makeup = dbToLin(p.makeupDb + (p.autoMakeup ? autoMakeupDb(p) : 0))
    // Fully off (and done fading out): only the detector runs, for the meters
    const off = !p.on && this.amt.settled(0)
    let lowest = 0
    let level = -100
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      const d = this.sc.process(x)
      let levelDb: number
      if (p.detector === 'rms') {
        this.ms += (d * d - this.ms) * rmsK
        // +3 dB so a sine reads its peak level, like the peak detector
        levelDb = linToDb(Math.sqrt(this.ms)) + 3.01
      } else {
        levelDb = linToDb(Math.abs(d))
      }
      if (levelDb > level) level = levelDb
      if (off) continue
      const target = compressorCurve(levelDb, p.thresholdDb, ratio, knee) - levelDb
      // More reduction = attack, less = release
      this.grDb += (target - this.grDb) * (target < this.grDb ? att : rel)
      if (this.grDb < lowest) lowest = this.grDb
      const y = x * dbToLin(this.grDb) * this.makeupSm.next(makeup)
      buf[i] = x + (y - x) * (this.wetSm.next(wet) * this.amt.next(p.on ? 1 : 0))
    }
    this.blockLevelDb = level
    if (off) this.grDb = 0
    this.blockGr = p.on ? lowest : 0
    this.sc.flush()
    if (this.ms < DENORMAL) this.ms = 0
  }
}

// ---- De-esser

export interface DeEsserParams {
  on: boolean
  /** Centre of the sibilance band (and split point), Hz */
  freq: number
  /** Width of the detection band (Q) */
  q: number
  thresholdDb: number
  /** Compression ratio above the threshold */
  ratio: number
  /** Maximum reduction, dB (negative) */
  rangeDb: number
  /** 'split' only turns the highs down; 'wide' turns the whole signal down */
  mode: 'split' | 'wide'
  /** Outputs the detection band alone, to tune the frequency by ear */
  listen: boolean
}

export class DeEsser {
  private bp: Section
  private lp: Section
  private env = 0
  private grDb = 0
  private key = ''
  private amt: Smoother
  blockGr = 0

  constructor(private sampleRate: number, private p: DeEsserParams) {
    this.bp = new Section(sampleRate)
    this.lp = new Section(sampleRate)
    this.amt = new Smoother(sampleRate)
    this.set(p)
  }

  set(p: DeEsserParams): void {
    this.p = p
    const key = `${p.freq}|${p.q}`
    if (key === this.key) return
    this.key = key
    const f = Math.max(1000, Math.min(this.sampleRate * 0.45, p.freq))
    this.bp.design('bandpass', f, Math.max(0.3, p.q ?? 1.4))
    // Split: low = LP(x), high = x − low, so the bands always add back up exactly
    this.lp.design('lowpass', f * 0.6)
  }

  process(buf: Float32Array): void {
    const p = this.p
    if (!p.on && this.amt.settled(0)) {
      this.grDb = 0
      this.blockGr = 0
      return
    }
    const att = coef(0.5, this.sampleRate)
    const rel = coef(60, this.sampleRate)
    const envDecay = Math.exp(-1 / (0.02 * this.sampleRate))
    const range = Math.min(0, p.rangeDb)
    const slope = 1 - 1 / Math.max(1, p.ratio ?? 4)
    let lowest = 0
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      const s = this.bp.process(x)
      const a = Math.abs(s)
      this.env = a > this.env ? a : this.env * envDecay
      const over = linToDb(this.env) - p.thresholdDb
      const target = over > 0 ? Math.max(range, -over * slope) : 0
      this.grDb += (target - this.grDb) * (target < this.grDb ? att : rel)
      const gDb = this.grDb * this.amt.next(p.on ? 1 : 0)
      if (gDb < lowest) lowest = gDb
      const g = dbToLin(gDb)
      const low = this.lp.process(x)
      if (p.listen) buf[i] = s
      else if (p.mode === 'wide') buf[i] = x * g
      else buf[i] = low + (x - low) * g
    }
    this.blockGr = lowest
    this.bp.flush()
    this.lp.flush()
    if (this.env < DENORMAL) this.env = 0
  }
}

// ---- Saturation

export interface SaturationParams {
  on: boolean
  /**
   * 'tape' = symmetric (odd harmonics), 'tube' = asymmetric (adds even harmonics),
   * 'amp' = guitar/bass amp drive: harder, asymmetric clipping that keeps half the drive as level
   */
  mode: 'tape' | 'tube' | 'amp'
  driveDb: number
  /** Brightness of the saturated part: low-pass on the wet signal, Hz */
  toneHz: number
  /** Dry/wet, % */
  mix: number
}

const TUBE_BIAS = 0.25
const TUBE_SLOPE = 1 - Math.tanh(TUBE_BIAS) ** 2

/** Static saturation curve, unity gain for small signals */
export function saturate(x: number, drive: number, mode: SaturationParams['mode']): number {
  const u = x * drive
  if (mode === 'amp') return ampClip(u) / Math.sqrt(drive)
  const y = mode === 'tube' ? (Math.tanh(u + TUBE_BIAS) - Math.tanh(TUBE_BIAS)) / TUBE_SLOPE : Math.tanh(u)
  return y / drive
}

/** Sharper knee than tanh, and the negative half clips earlier (like a single-ended stage) */
function ampClip(u: number): number {
  const lim = u >= 0 ? 1 : 0.7
  const v = u / lim
  return (lim * v) / Math.pow(1 + Math.pow(Math.abs(v), 4), 0.25)
}

/** The curve runs at this many times the sample rate, so its harmonics don't fold back (aliasing) */
const SAT_OS = 4
const SAT_TAPS = 129
/** Delay of the oversampling filters (up + down), samples; the dry path waits as long */
export const SAT_LATENCY = (SAT_TAPS - 1) / SAT_OS

function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

/** Linear-phase low-pass at the oversampled rate (Kaiser-windowed sinc, cut at 0.45 × the base rate), unity DC gain */
export const SAT_FIR: Float64Array = (() => {
  const h = new Float64Array(SAT_TAPS)
  const mid = (SAT_TAPS - 1) / 2
  const fc = 0.45 / SAT_OS
  const beta = 8
  let sum = 0
  for (let i = 0; i < SAT_TAPS; i++) {
    const t = i - mid
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)
    h[i] = (sinc * besselI0(beta * Math.sqrt(1 - (t / mid) ** 2))) / besselI0(beta)
    sum += h[i]
  }
  for (let i = 0; i < SAT_TAPS; i++) h[i] /= sum
  return h
})()

const SAT_PHASE_TAPS = Math.ceil(SAT_TAPS / SAT_OS)

/** Interpolator phases: output k of each input sample = SAT_OS · Σ h[k + SAT_OS·m] · x[t − m] */
const SAT_PHASES: Float64Array[] = Array.from({ length: SAT_OS }, (_, k) => {
  const ph = new Float64Array(SAT_PHASE_TAPS)
  for (let m = 0; m < SAT_PHASE_TAPS; m++) {
    const i = k + SAT_OS * m
    ph[m] = i < SAT_TAPS ? SAT_FIR[i] * SAT_OS : 0
  }
  return ph
})

const SAT_IN_MASK = 63
const SAT_OS_MASK = 255

export class Saturator {
  private tone: Section
  private toneHz = -1
  private dc = 0
  private dcIn = 0
  private amt: Smoother
  private driveSm: Smoother
  private wetSm: Smoother
  /** Dry path, delayed like the oversampled one */
  private dry = new Float64Array(SAT_LATENCY)
  private dryPos = 0
  private xh = new Float64Array(SAT_IN_MASK + 1)
  private xPos = 0
  private os = new Float64Array(SAT_OS_MASK + 1)
  private osPos = 0

  constructor(private sampleRate: number, private p: SaturationParams) {
    this.tone = new Section(sampleRate)
    this.amt = new Smoother(sampleRate)
    this.driveSm = new Smoother(sampleRate)
    this.wetSm = new Smoother(sampleRate)
    this.set(p)
  }

  set(p: SaturationParams): void {
    this.p = p
    if (p.toneHz !== this.toneHz) {
      this.toneHz = p.toneHz
      this.tone.design('lowpass', p.toneHz >= 19000 ? 0 : p.toneHz)
    }
  }

  process(buf: Float32Array): void {
    const p = this.p
    // The delay always runs, so latency doesn't change when the saturator is switched
    const off = !p.on && this.amt.settled(0)
    const drive = dbToLin(Math.max(0, p.driveDb))
    const wet = Math.max(0, Math.min(100, p.mix)) / 100
    // DC blocker after the asymmetric curve (~5 Hz)
    const r = 1 - (2 * Math.PI * 5) / this.sampleRate
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      const d = this.dry[this.dryPos]
      this.dry[this.dryPos] = x
      this.dryPos = (this.dryPos + 1) % SAT_LATENCY
      this.xh[this.xPos] = x
      if (off) {
        this.xPos = (this.xPos + 1) & SAT_IN_MASK
        buf[i] = d
        continue
      }
      // Up 4×, saturate, back down: the harmonics above the base Nyquist are filtered out
      const dr = this.driveSm.next(drive)
      for (let k = 0; k < SAT_OS; k++) {
        const ph = SAT_PHASES[k]
        let acc = 0
        for (let m = 0; m < SAT_PHASE_TAPS; m++) acc += ph[m] * this.xh[(this.xPos - m) & SAT_IN_MASK]
        this.os[(this.osPos + k) & SAT_OS_MASK] = saturate(acc, dr, p.mode)
      }
      // Symmetric filter: pair the taps that share a coefficient
      const half = (SAT_TAPS - 1) / 2
      let sat = SAT_FIR[half] * this.os[(this.osPos - half) & SAT_OS_MASK]
      for (let j = 0; j < half; j++) sat += SAT_FIR[j] * (this.os[(this.osPos - j) & SAT_OS_MASK] + this.os[(this.osPos - (SAT_TAPS - 1 - j)) & SAT_OS_MASK])
      this.osPos = (this.osPos + SAT_OS) & SAT_OS_MASK
      this.xPos = (this.xPos + 1) & SAT_IN_MASK
      const y = sat - this.dcIn + r * this.dc
      this.dcIn = sat
      this.dc = y
      const s = this.tone.process(y)
      buf[i] = d + (s - d) * (this.wetSm.next(wet) * this.amt.next(p.on ? 1 : 0))
    }
    this.tone.flush()
    if (Math.abs(this.dc) < DENORMAL) this.dc = 0
    if (Math.abs(this.dcIn) < DENORMAL) this.dcIn = 0
  }
}

// ---- Look-ahead true-peak limiter

export interface LimiterParams {
  on: boolean
  /** True-peak ceiling: inter-sample peaks (what a DAC or an encoder reconstructs) stay below it */
  ceilingDb: number
  releaseMs: number
}

/** Look-ahead time: the gain is fully down by the time a peak comes out */
export const LOOKAHEAD_MS = 1.5

export function lookaheadSamples(sampleRate: number): number {
  return Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate))
}

/** The true-peak interpolator reports a peak this many samples after it entered */
const TP_DELAY = 5

/** Total delay of the limiter (look-ahead + true-peak detection); the dry path waits as long */
export function limiterLatency(sampleRate: number): number {
  return lookaheadSamples(sampleRate) + TP_DELAY
}

/** Delay of the whole dynamics section (saturator oversampling + limiter), samples */
export function dynamicsLatency(sampleRate: number): number {
  return SAT_LATENCY + limiterLatency(sampleRate)
}

export class Limiter {
  readonly latency: number
  /** Look-ahead window, samples */
  private w: number
  private delay: Float32Array
  private pos = 0
  /** Input history for the true-peak interpolator, stored twice to read it without modulo */
  private hist = new Float64Array(TAPS_PER_PHASE * 2)
  private hPos = 0
  /** Gain needed now: instant attack, release back towards 1 */
  private env = 1
  /** Minimum of env over the last w + 1 samples: monotonic queue of (value, step), oldest first */
  private qVal: Float64Array
  private qStep: Float64Array
  private qHead = 0
  private qLen = 0
  private step = 0
  /** Last w held minima (moving average) */
  private avg: Float64Array
  private avgPos = 0
  private sum: number
  private amt: Smoother
  blockGr = 0

  constructor(private sampleRate: number, private p: LimiterParams) {
    this.w = lookaheadSamples(sampleRate)
    this.latency = this.w + TP_DELAY
    this.delay = new Float32Array(this.latency)
    this.qVal = new Float64Array(this.w + 2)
    this.qStep = new Float64Array(this.w + 2)
    this.avg = new Float64Array(this.w).fill(1)
    this.sum = this.w
    this.amt = new Smoother(sampleRate)
  }

  set(p: LimiterParams): void {
    this.p = p
  }

  process(buf: Float32Array): void {
    const p = this.p
    const w = this.w
    const ceil = dbToLin(Math.min(0, p.ceilingDb))
    const rel = coef(p.releaseMs, this.sampleRate)
    // Locals for the hot loop (module bindings are slower to read per sample)
    const hist = this.hist
    const phases = POLYPHASE
    const taps = TAPS_PER_PHASE
    let lowest = 1
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i]
      // The delay always runs, so latency doesn't change when the limiter is switched
      const out = this.delay[this.pos]
      this.delay[this.pos] = x
      this.pos = (this.pos + 1) % this.latency
      // True peak between the samples that entered 6 and 5 steps ago (4× interpolation, BS.1770)
      hist[this.hPos] = x
      hist[this.hPos + taps] = x
      const newest = this.hPos + taps
      let peak = Math.abs(hist[newest - 6])
      for (let k = 0; k < OVERSAMPLE; k++) {
        const ph = phases[k]
        let acc = 0
        for (let m = 0; m < taps; m++) acc += ph[m] * hist[newest - m]
        const a = Math.abs(acc)
        if (a > peak) peak = a
      }
      this.hPos = (this.hPos + 1) % taps
      const need = peak > ceil ? ceil / peak : 1
      const released = this.env + (1 - this.env) * rel
      this.env = need < released ? need : released
      // Hold the lowest gain over the window, then average it over the window: the gain glides
      // down (no step, no distortion) and is fully down exactly when the peak comes out
      const m = this.holdMin(this.env, w + 1)
      this.sum += m - this.avg[this.avgPos]
      this.avg[this.avgPos] = m
      this.avgPos = (this.avgPos + 1) % w
      const g = this.sum / w
      let y = out * (1 + (g - 1) * this.amt.next(p.on ? 1 : 0))
      if (p.on) {
        // Safety net for rounding: never engages on a signal the gain already handled
        if (y > ceil) y = ceil
        else if (y < -ceil) y = -ceil
        if (g < lowest) lowest = g
      }
      buf[i] = y
    }
    // Re-add the window so the running sum never drifts
    let s = 0
    for (let j = 0; j < w; j++) s += this.avg[j]
    this.sum = s
    this.blockGr = p.on ? linToDb(lowest) : 0
  }

  /** Pushes v and returns the minimum of the last `span` values (≥ 1 when fewer were pushed) */
  private holdMin(v: number, span: number): number {
    const cap = this.qVal.length
    // Values at the back that are not lower than v can never be the minimum again
    while (this.qLen > 0 && this.qVal[(this.qHead + this.qLen - 1) % cap] >= v) this.qLen--
    const at = (this.qHead + this.qLen) % cap
    this.qVal[at] = v
    this.qStep[at] = this.step
    this.qLen++
    if (this.qStep[this.qHead] <= this.step - span) {
      this.qHead = (this.qHead + 1) % cap
      this.qLen--
    }
    this.step++
    return Math.min(1, this.qVal[this.qHead])
  }
}
