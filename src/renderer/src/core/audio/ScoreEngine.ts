import { MIN_DB, type LevelReading } from './LevelAnalyzer'

export interface ScoreOptions {
  noiseFloorDb: number
  /** dB above the noise floor that maps to a perfect 100 (lower = more sensitive) */
  rangeDb: number
  /** Loudness must hold this long to count — kills mic taps and claps */
  minBurstMs: number
  /** Age handicap multiplier (1 = none) */
  multiplier: number
}

export interface ScoreResult {
  score: number
  /** Loudest level held for at least minBurstMs, dBFS */
  sustainedPeakDb: number
  /** Mean level over the whole window, dBFS */
  averageDb: number
  /** Fraction of the window spent clearly above the noise floor */
  voicedRatio: number
  clipped: boolean
  multiplier: number
}

const PEAK_WEIGHT = 0.7
const AVERAGE_WEIGHT = 0.3
const VOICED_MARGIN_DB = 6

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  noiseFloorDb: -60,
  rangeDb: 50,
  minBurstMs: 150,
  multiplier: 1
}

function above(db: number, floor: number): number {
  return db <= MIN_DB ? 0 : Math.max(0, db - floor)
}

/** Highest average level over any window of `windowMs` */
export function sustainedPeak(frames: LevelReading[], floor: number, windowMs: number): number {
  let best = 0
  let start = 0
  let sum = 0
  for (let end = 0; end < frames.length; end++) {
    sum += above(frames[end].rmsDb, floor)
    while (frames[end].t - frames[start].t > windowMs) {
      sum -= above(frames[start].rmsDb, floor)
      start++
    }
    // Only full windows count, otherwise the first frames would score alone
    if (frames[end].t - frames[0].t >= windowMs) {
      best = Math.max(best, sum / (end - start + 1))
    }
  }
  return best
}

export function scoreScream(frames: LevelReading[], opts: ScoreOptions): ScoreResult {
  const floor = opts.noiseFloorDb
  if (frames.length === 0) {
    return { score: 0, sustainedPeakDb: floor, averageDb: floor, voicedRatio: 0, clipped: false, multiplier: opts.multiplier }
  }
  const peakAbove = sustainedPeak(frames, floor, opts.minBurstMs)
  const levels = frames.map((f) => above(f.rmsDb, floor))
  const avgAbove = levels.reduce((a, b) => a + b, 0) / levels.length
  const voiced = levels.filter((l) => l > VOICED_MARGIN_DB).length / levels.length

  const raw = ((PEAK_WEIGHT * peakAbove + AVERAGE_WEIGHT * avgAbove) / opts.rangeDb) * 100
  const score = Math.min(100, Math.max(0, raw * opts.multiplier))

  return {
    score: Math.round(score * 10) / 10,
    sustainedPeakDb: floor + peakAbove,
    averageDb: floor + avgAbove,
    voicedRatio: voiced,
    clipped: frames.some((f) => f.clipped),
    multiplier: opts.multiplier
  }
}

/**
 * Live detector for the silence challenge: "broken" once the level stays
 * `toleranceDb` above the floor for `breakMs` (a single cough-click is forgiven).
 */
export class SilenceWatcher {
  private startT: number | null = null
  private loudSince: number | null = null
  brokenAt: number | null = null

  constructor(
    private floorDb: number,
    private toleranceDb = 10,
    private breakMs = 300
  ) {}

  push(r: LevelReading): boolean {
    if (this.brokenAt !== null) return true
    if (this.startT === null) this.startT = r.t
    if (r.rmsDb > this.floorDb + this.toleranceDb) {
      if (this.loudSince === null) this.loudSince = r.t
      if (r.t - this.loudSince >= this.breakMs) {
        this.brokenAt = this.loudSince
        return true
      }
    } else {
      this.loudSince = null
    }
    return false
  }

  survivedMs(now: number): number {
    if (this.startT === null) return 0
    return (this.brokenAt ?? now) - this.startT
  }
}

/**
 * Live detector for the longest-scream challenge: the clock starts when the level rises
 * `thresholdDb` above the floor and stops once it stays below for `gapMs`
 * (a quick wobble in the voice is forgiven). No scream within `startMs` scores 0 s.
 */
export class SustainWatcher {
  private firstT: number | null = null
  private loudStart: number | null = null
  private lastLoud: number | null = null
  ended = false

  constructor(
    private floorDb: number,
    private thresholdDb = 20,
    private gapMs = 250,
    private startMs = 4000
  ) {}

  /** Returns true once the scream is over (or never started) */
  push(r: LevelReading): boolean {
    if (this.ended) return true
    if (this.firstT === null) this.firstT = r.t
    if (r.rmsDb > this.floorDb + this.thresholdDb) {
      if (this.loudStart === null) this.loudStart = r.t
      this.lastLoud = r.t
    } else if (this.lastLoud !== null && r.t - this.lastLoud >= this.gapMs) {
      this.ended = true
    } else if (this.loudStart === null && r.t - this.firstT >= this.startMs) {
      this.ended = true
    }
    return this.ended
  }

  get started(): boolean {
    return this.loudStart !== null
  }

  heldMs(now?: number): number {
    if (this.loudStart === null || this.lastLoud === null) return 0
    return (this.ended || now === undefined ? this.lastLoud : Math.max(this.lastLoud, now)) - this.loudStart
  }
}
