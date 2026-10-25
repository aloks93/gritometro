import { aWeighting, ampToDb, cWeighting, FilterChain, kWeighting, TruePeakMeter } from './dsp'

// Streaming loudness (EBU R128 / ITU-R BS.1770) and sound level (IEC 61672) meters.
// Both take raw PCM chunks of any size; the UI polls their readings.

export const LUFS_FLOOR = -70

function msToLufs(ms: number): number {
  return ms > 0 ? Math.max(-100, -0.691 + 10 * Math.log10(ms)) : -100
}

function lufsToMs(l: number): number {
  return Math.pow(10, (l + 0.691) / 10)
}

export interface LoudnessReading {
  /** 400 ms window */
  momentary: number
  /** 3 s window */
  shortTerm: number
  /** Gated programme loudness since reset */
  integrated: number
  /** Loudness range (LU) of the short-term values */
  lra: number
  maxMomentary: number
  maxShortTerm: number
  /** Highest true peak since reset, dBTP */
  truePeakDb: number
  durationS: number
}

/** Mono EBU R128 meter: 100 ms sub-blocks feed the 400 ms / 3 s windows */
export class LoudnessMeter {
  private filter: FilterChain
  private tp = new TruePeakMeter()
  private subSize: number
  private subSum = 0
  private subCount = 0
  /** Mean square of each completed 100 ms sub-block */
  private subs: number[] = []
  /** 400 ms block loudness (75 % overlap) for the integrated gate */
  private blocks: number[] = []
  /** 3 s short-term loudness every 100 ms for LRA */
  private shorts: number[] = []
  private maxM = -100
  private maxS = -100

  constructor(readonly sampleRate: number) {
    this.filter = new FilterChain(kWeighting(sampleRate))
    this.subSize = Math.round(sampleRate / 10)
  }

  push(samples: ArrayLike<number>): void {
    this.tp.push(samples)
    for (let i = 0; i < samples.length; i++) {
      const y = this.filter.process(samples[i])
      this.subSum += y * y
      if (++this.subCount === this.subSize) this.closeSub()
    }
  }

  private closeSub(): void {
    this.subs.push(this.subSum / this.subSize)
    this.subSum = 0
    this.subCount = 0
    const n = this.subs.length
    if (n >= 4) {
      const m = msToLufs(this.windowMs(4))
      this.blocks.push(m)
      if (m > this.maxM) this.maxM = m
    }
    if (n >= 30) {
      const s = msToLufs(this.windowMs(30))
      this.shorts.push(s)
      if (s > this.maxS) this.maxS = s
    }
  }

  private windowMs(count: number): number {
    const n = this.subs.length
    if (n === 0) return 0
    const from = Math.max(0, n - count)
    let sum = 0
    for (let i = from; i < n; i++) sum += this.subs[i]
    // Before the window fills, average over what exists (meters still move at start)
    return sum / (n - from)
  }

  integrated(): number {
    return gatedLoudness(this.blocks, -10)
  }

  lra(): number {
    return loudnessRange(this.shorts)
  }

  reading(): LoudnessReading {
    return {
      momentary: msToLufs(this.windowMs(4)),
      shortTerm: msToLufs(this.windowMs(30)),
      integrated: this.integrated(),
      lra: this.lra(),
      maxMomentary: this.maxM,
      maxShortTerm: this.maxS,
      truePeakDb: ampToDb(this.tp.max),
      durationS: (this.subs.length * this.subSize + this.subCount) / this.sampleRate
    }
  }

  reset(): void {
    this.filter.reset()
    this.tp.reset()
    this.subSum = 0
    this.subCount = 0
    this.subs = []
    this.blocks = []
    this.shorts = []
    this.maxM = -100
    this.maxS = -100
  }
}

/** BS.1770 two-stage gate: absolute −70 LUFS, then `relativeLu` below the ungated mean */
export function gatedLoudness(blocks: number[], relativeLu: number): number {
  const abs = blocks.filter((b) => b > LUFS_FLOOR)
  if (abs.length === 0) return -100
  const mean = abs.reduce((a, b) => a + lufsToMs(b), 0) / abs.length
  const rel = msToLufs(mean) + relativeLu
  const gated = abs.filter((b) => b > rel)
  if (gated.length === 0) return -100
  return msToLufs(gated.reduce((a, b) => a + lufsToMs(b), 0) / gated.length)
}

/** EBU Tech 3342 loudness range: 10th–95th percentile of gated short-term values */
export function loudnessRange(shorts: number[]): number {
  const abs = shorts.filter((s) => s > LUFS_FLOOR)
  if (abs.length < 2) return 0
  const mean = abs.reduce((a, b) => a + lufsToMs(b), 0) / abs.length
  const rel = msToLufs(mean) - 20
  const gated = abs.filter((s) => s > rel).sort((a, b) => a - b)
  if (gated.length < 2) return 0
  const pick = (p: number): number => gated[Math.min(gated.length - 1, Math.round((gated.length - 1) * p))]
  return Math.round((pick(0.95) - pick(0.1)) * 10) / 10
}

/** One-shot loudness of a whole take */
export function measureLoudness(pcm: Float32Array, sampleRate: number): LoudnessReading {
  const m = new LoudnessMeter(sampleRate)
  m.push(pcm)
  return m.reading()
}

// ---- Sound level meter

export type Weighting = 'A' | 'C' | 'Z'
export type TimeWeighting = 'F' | 'S'

export interface SlmReading {
  /** Time-weighted level now, per frequency weighting (dB SPL with the calibration offset) */
  fast: Record<Weighting, number>
  slow: Record<Weighting, number>
  /** Equivalent continuous level since reset */
  leq: Record<Weighting, number>
  /** Max/min of the fast level since reset */
  max: Record<Weighting, number>
  min: Record<Weighting, number>
  /** C-weighted peak since reset */
  peakC: number
  durationS: number
}

const WEIGHTINGS: Weighting[] = ['A', 'C', 'Z']

/**
 * IEC 61672-style meter on raw PCM. Levels are dBFS (RMS, 0 dB = full-scale square)
 * plus `offsetDb`, which is the profile's SPL calibration.
 */
export class SoundLevelMeter {
  private filters: Record<'A' | 'C', FilterChain>
  private fastSq: Record<Weighting, number> = { A: 0, C: 0, Z: 0 }
  private slowSq: Record<Weighting, number> = { A: 0, C: 0, Z: 0 }
  private sumSq: Record<Weighting, number> = { A: 0, C: 0, Z: 0 }
  private maxSq: Record<Weighting, number> = { A: 0, C: 0, Z: 0 }
  private minSq: Record<Weighting, number> = { A: Infinity, C: Infinity, Z: Infinity }
  private peakC = 0
  private n = 0
  private kFast: number
  private kSlow: number
  /** Ignore min/max until the exponential averages have settled */
  private settle: number

  constructor(
    readonly sampleRate: number,
    public offsetDb = 0
  ) {
    this.filters = { A: new FilterChain(aWeighting(sampleRate)), C: new FilterChain(cWeighting(sampleRate)) }
    this.kFast = 1 - Math.exp(-1 / (0.125 * sampleRate))
    this.kSlow = 1 - Math.exp(-1 / (1 * sampleRate))
    this.settle = Math.round(sampleRate * 0.5)
  }

  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      const z = samples[i]
      const a = this.filters.A.process(z)
      const c = this.filters.C.process(z)
      const ac = Math.abs(c)
      if (ac > this.peakC) this.peakC = ac
      this.step('A', a * a)
      this.step('C', c * c)
      this.step('Z', z * z)
      this.n++
    }
  }

  private step(w: Weighting, sq: number): void {
    this.fastSq[w] += (sq - this.fastSq[w]) * this.kFast
    this.slowSq[w] += (sq - this.slowSq[w]) * this.kSlow
    this.sumSq[w] += sq
    if (this.n >= this.settle) {
      if (this.fastSq[w] > this.maxSq[w]) this.maxSq[w] = this.fastSq[w]
      if (this.fastSq[w] < this.minSq[w]) this.minSq[w] = this.fastSq[w]
    }
  }

  private db(sq: number): number {
    // Same convention as the level meter: a full-scale sine reads −3 dBFS
    return sq > 0 && Number.isFinite(sq) ? Math.max(-100, 10 * Math.log10(sq)) + this.offsetDb : -100 + this.offsetDb
  }

  reading(): SlmReading {
    const map = (fn: (w: Weighting) => number): Record<Weighting, number> =>
      Object.fromEntries(WEIGHTINGS.map((w) => [w, round1(fn(w))])) as Record<Weighting, number>
    return {
      fast: map((w) => this.db(this.fastSq[w])),
      slow: map((w) => this.db(this.slowSq[w])),
      leq: map((w) => this.db(this.n ? this.sumSq[w] / this.n : 0)),
      max: map((w) => this.db(this.maxSq[w])),
      min: map((w) => this.db(Number.isFinite(this.minSq[w]) ? this.minSq[w] : 0)),
      peakC: round1(ampToDb(this.peakC) + this.offsetDb),
      durationS: this.n / this.sampleRate
    }
  }

  reset(): void {
    for (const w of WEIGHTINGS) {
      this.sumSq[w] = 0
      this.maxSq[w] = 0
      this.minSq[w] = Infinity
    }
    this.peakC = 0
    this.n = 0
  }
}

/** Offset that makes the measured level read `referenceDb` (e.g. a 94 dB calibrator) */
export function calibrationOffset(measuredDbfs: number, referenceDb: number): number {
  return Math.round((referenceDb - measuredDbfs) * 10) / 10
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
