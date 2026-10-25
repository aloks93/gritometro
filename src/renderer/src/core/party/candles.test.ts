import { describe, expect, it } from 'vitest'
import { allOut, blowCandles, lightCandles, MAX_CANDLES } from './candles'
import { createPlayer, isBirthdayPlayer } from '../players/players'

function blowFor(ms: number, level: number, s = lightCandles(3)) {
  for (let t = 0; t < ms; t += 16) s = blowCandles(s, level, 16)
  return s
}

describe('candles', () => {
  it('lights one candle per year, within limits', () => {
    expect(lightCandles(7).lit).toBe(7)
    expect(lightCandles().lit).toBe(5)
    expect(lightCandles(0).lit).toBe(1)
    expect(lightCandles(40).lit).toBe(MAX_CANDLES)
  })

  it('steady blowing puts them out one by one', () => {
    const s = blowFor(700, 0.3)
    expect(s.lit).toBe(2)
    expect(allOut(blowFor(2000, 0.3))).toBe(true)
  })

  it('blowing harder is faster', () => {
    expect(blowFor(600, 0.9).lit).toBeLessThan(blowFor(600, 0.35).lit)
  })

  it('talking quietly does nothing and progress recovers', () => {
    expect(blowFor(5000, 0.1).lit).toBe(3)
    const half = blowFor(200, 0.3)
    expect(half.progress).toBeGreaterThan(0)
    expect(blowFor(2000, 0, half).progress).toBe(0)
  })

  it('ignores huge frame gaps', () => {
    expect(blowCandles(lightCandles(3), 1, 60000).lit).toBeGreaterThan(0)
  })
})

describe('isBirthdayPlayer', () => {
  it('matches the name ignoring case, accents and spaces', () => {
    expect(isBirthdayPlayer(createPlayer('Sofía'), ' sofia ')).toBe(true)
    expect(isBirthdayPlayer(createPlayer('Sofi'), 'Sofía')).toBe(false)
    expect(isBirthdayPlayer(createPlayer('Ana'), '')).toBe(false)
  })
})
