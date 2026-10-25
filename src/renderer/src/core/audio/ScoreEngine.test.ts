import { describe, expect, it } from 'vitest'
import type { LevelReading } from './LevelAnalyzer'
import { MIN_DB, rms, toDb, smooth, normalizeLevel } from './LevelAnalyzer'
import { scoreScream, SilenceWatcher, sustainedPeak } from './ScoreEngine'
import { noiseFloorFrom } from './Calibration'

const FRAME_MS = 16

function frames(levels: number[]): LevelReading[] {
  return levels.map((db, i) => ({ t: i * FRAME_MS, rmsDb: db, peakDb: db, smoothedDb: db, clipped: false }))
}

function constant(db: number, ms: number): number[] {
  return Array(Math.round(ms / FRAME_MS)).fill(db)
}

const opts = { noiseFloorDb: -60, rangeDb: 50, minBurstMs: 150, multiplier: 1 }

describe('LevelAnalyzer', () => {
  it('computes rms and dB', () => {
    expect(rms([1, -1, 1, -1])).toBe(1)
    expect(toDb(1)).toBe(0)
    expect(toDb(0.1)).toBeCloseTo(-20)
    expect(toDb(0)).toBe(MIN_DB)
  })
  it('peak ballistics attack instantly and release slowly', () => {
    expect(smooth(-60, -10, 'peak')).toBe(-10)
    expect(smooth(-10, -60, 'peak')).toBeGreaterThan(-15)
  })
  it('normalizes relative to floor', () => {
    expect(normalizeLevel(-60, -60, 50)).toBe(0)
    expect(normalizeLevel(-35, -60, 50)).toBe(0.5)
    expect(normalizeLevel(0, -60, 50)).toBe(1)
  })
})

describe('scoreScream', () => {
  it('scores silence as zero', () => {
    expect(scoreScream(frames(constant(-60, 3000)), opts).score).toBe(0)
  })

  it('louder sustained screams score higher', () => {
    const quiet = scoreScream(frames(constant(-40, 3000)), opts).score
    const loud = scoreScream(frames(constant(-20, 3000)), opts).score
    expect(loud).toBeGreaterThan(quiet)
    // 40 dB above floor over a 50 dB range -> 80
    expect(loud).toBeCloseTo(80, 0)
  })

  it('ignores a short tap on the microphone (anti-trampa)', () => {
    const tap = [...constant(-60, 1000), ...constant(-5, 48), ...constant(-60, 1950)]
    const scream = [...constant(-60, 1000), ...constant(-30, 1000), ...constant(-60, 1000)]
    expect(scoreScream(frames(tap), opts).score).toBeLessThan(scoreScream(frames(scream), opts).score)
  })

  it('a longer scream at the same level beats a shorter one', () => {
    const short = [...constant(-25, 400), ...constant(-60, 2600)]
    const long = constant(-25, 3000)
    expect(scoreScream(frames(long), opts).score).toBeGreaterThan(scoreScream(frames(short), opts).score)
  })

  it('applies the age handicap and caps at 100', () => {
    const f = frames(constant(-30, 3000))
    const base = scoreScream(f, opts).score
    expect(scoreScream(f, { ...opts, multiplier: 1.3 }).score).toBeCloseTo(base * 1.3, 0)
    expect(scoreScream(frames(constant(0, 3000)), { ...opts, multiplier: 2 }).score).toBe(100)
  })

  it('sustainedPeak needs a full window', () => {
    expect(sustainedPeak(frames(constant(-10, 64)), -60, 150)).toBe(0)
  })
})

describe('SilenceWatcher', () => {
  it('forgives a short click but breaks on sustained noise', () => {
    const w = new SilenceWatcher(-60, 10, 300)
    const seq = frames([...constant(-60, 1000), ...constant(-30, 100), ...constant(-60, 1000), ...constant(-30, 500)])
    let brokeAt = -1
    seq.forEach((r, i) => {
      if (w.push(r) && brokeAt < 0) brokeAt = i
    })
    expect(brokeAt).toBeGreaterThan(0)
    expect(w.survivedMs(99999)).toBeGreaterThan(2000)
    expect(w.survivedMs(99999)).toBeLessThan(2200)
  })
})

describe('noiseFloorFrom', () => {
  it('uses the 90th percentile', () => {
    const levels = [...Array(90).fill(-60), ...Array(10).fill(-20)]
    expect(noiseFloorFrom(frames(levels))).toBe(-20)
    expect(noiseFloorFrom(frames([...Array(95).fill(-60), ...Array(5).fill(-20)]))).toBe(-60)
  })
})
