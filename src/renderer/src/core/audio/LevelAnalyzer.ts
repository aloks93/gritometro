import type { Ballistics } from './AudioConfig'

export const MIN_DB = -100
export const CLIP_THRESHOLD = 0.99

export interface LevelReading {
  /** ms timestamp (performance.now) */
  t: number
  /** RMS of the frame, dBFS */
  rmsDb: number
  /** Absolute sample peak of the frame, dBFS */
  peakDb: number
  /** RMS smoothed with the selected ballistics, dBFS — what the meter shows */
  smoothedDb: number
  clipped: boolean
}

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

export function peak(samples: ArrayLike<number>): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > max) max = v
  }
  return max
}

export function toDb(amplitude: number): number {
  if (amplitude <= 0) return MIN_DB
  return Math.max(MIN_DB, 20 * Math.log10(amplitude))
}

/** Per-frame (≈16 ms) attack/release coefficients */
const BALLISTICS: Record<Ballistics, { attack: number; release: number }> = {
  fast: { attack: 0.7, release: 0.25 },
  vu: { attack: 0.12, release: 0.12 },
  peak: { attack: 1, release: 0.04 }
}

export function smooth(previousDb: number, currentDb: number, mode: Ballistics): number {
  const { attack, release } = BALLISTICS[mode]
  const k = currentDb > previousDb ? attack : release
  return previousDb + (currentDb - previousDb) * k
}

export function analyzeFrame(
  samples: Float32Array,
  t: number,
  previousSmoothedDb: number,
  ballistics: Ballistics,
  gateDb: number
): LevelReading {
  const p = peak(samples)
  let rmsDb = toDb(rms(samples))
  if (rmsDb < gateDb) rmsDb = MIN_DB
  return {
    t,
    rmsDb,
    peakDb: toDb(p),
    smoothedDb: smooth(previousSmoothedDb, rmsDb, ballistics),
    clipped: p >= CLIP_THRESHOLD
  }
}

/** Maps a dBFS value to 0..1 for a meter, relative to the noise floor */
export function normalizeLevel(db: number, noiseFloorDb: number, rangeDb: number): number {
  return Math.min(1, Math.max(0, (db - noiseFloorDb) / rangeDb))
}
