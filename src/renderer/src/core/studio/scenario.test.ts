import { describe, expect, it } from 'vitest'
import type { TakeMetrics } from './analysis'
import { curveDistance, rankForScenario, relativeSensitivity, scenarioScore, scenarioSummary, SCENARIOS, winnersByScenario } from './scenario'
import type { MicCandidate } from './studio'

const metrics = (over: Partial<TakeMetrics> = {}): TakeMetrics => ({
  noiseFloorDb: -72,
  levelDb: -20,
  peakDb: -8,
  snrDb: 52,
  crestDb: 14,
  clipCount: 0,
  centroidHz: 2000,
  bands: { low: 0.25, mid: 0.65, high: 0.1 },
  curve: [0, 0, 0],
  durationS: 8,
  ...over
})

const mic = (id: string, m: Partial<TakeMetrics>, gainDb = 0): MicCandidate => ({ id, name: id, deviceId: null, channel: 'mix', gainDb, metrics: metrics(m) })

describe('scenario weights', () => {
  it('every scenario adds up to 100 points', () => {
    for (const s of SCENARIOS) expect(Object.values(s.weights).reduce((a, b) => a + b, 0)).toBe(100)
  })

  it('a clean, well-levelled take scores high everywhere', () => {
    for (const s of SCENARIOS) expect(scenarioScore(metrics(), s.id).total).toBeGreaterThan(80)
  })

  it('explains what costs points', () => {
    const r = scenarioScore(metrics({ snrDb: 18, centroidHz: 500, bands: { low: 0.7, mid: 0.28, high: 0.02 } }), 'speech')
    expect(r.total).toBeLessThan(50)
    expect(r.notes.join(' | ')).toMatch(/SNR/)
    expect(r.notes.join(' | ')).toMatch(/oscuro/)
    expect(r.notes.join(' | ')).toMatch(/graves/i)
    expect(r.parts.reduce((a, p) => a + p.max, 0)).toBe(100)
  })

  it('hum and DC offset cost points in any use', () => {
    const clean = scenarioScore(metrics(), 'room').total
    expect(scenarioScore(metrics({ hum: { hz: 50, prominenceDb: 12 }, dcOffset: 0.05 }), 'room').total).toBe(clean - 12)
  })
})

describe('best mic per use', () => {
  // Quiet but hot (little headroom) vs. a bit noisier with lots of headroom
  const quietHot = mic('Condensador', { noiseFloorDb: -80, noiseADb: -84, snrDb: 60, peakDb: -1.5, truePeakDb: -1.2, clipCount: 2 })
  const robust = mic('Dinámico', { noiseFloorDb: -62, noiseADb: -64, snrDb: 38, peakDb: -12, truePeakDb: -11.5 })

  it('the dynamic wins for shouting, the condenser for podcast', () => {
    expect(rankForScenario([quietHot, robust], 'shout')[0].c.name).toBe('Dinámico')
    expect(rankForScenario([quietHot, robust], 'podcast')[0].c.name).toBe('Condensador')
    const w = winnersByScenario([quietHot, robust])
    expect(w).toHaveLength(SCENARIOS.length)
    expect(w.every((x) => x.margin !== null)).toBe(true)
    expect(scenarioSummary([quietHot, robust])[0]).toMatch(/^Voz hablada: /)
  })

  it('unmeasured mics are ignored', () => {
    expect(rankForScenario([{ id: 'x', name: 'x', deviceId: null, channel: 'mix', gainDb: 0 }], 'speech')).toEqual([])
    expect(winnersByScenario([])).toEqual([])
  })
})

describe('relative measures', () => {
  it('sensitivity removes the trim difference', () => {
    const ref = mic('ref', { levelDb: -20 }, 0)
    const hot = mic('hot', { levelDb: -14 }, 0)
    const trimmed = mic('trimmed', { levelDb: -14 }, 6)
    expect(relativeSensitivity(hot, ref)).toBe(6)
    expect(relativeSensitivity(trimmed, ref)).toBe(0)
    expect(relativeSensitivity({ ...hot, metrics: undefined }, ref)).toBeNull()
  })

  it('curve distance is the RMS dB difference', () => {
    expect(curveDistance([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0)
    expect(curveDistance([3, -3, 3, -3], [0, 0, 0, 0])).toBe(3)
    expect(curveDistance([], [])).toBe(0)
  })
})
