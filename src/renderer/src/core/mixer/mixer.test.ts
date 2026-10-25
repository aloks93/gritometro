import { describe, expect, it } from 'vitest'
import { compressorAutoMakeupDb, compressorCurve, highShelf, lowShelf, peaking, responseDb } from '../studio/dsp'
import {
  createStrip,
  autoTrim,
  dbToGain,
  defaultMixer,
  eqResponse,
  faderToPos,
  isAudible,
  loadScene,
  logFreqs,
  mergeMixer,
  panGains,
  parseMixer,
  posToFader,
  routingWarnings,
  saveScene,
  serializeMixer,
  stripOutputGain
} from './mixer'

const SR = 48000

describe('EQ filters (Web Audio conventions)', () => {
  it('peaking boosts its centre by the gain and leaves far bands alone', () => {
    const p = [peaking(1000, 6, 1, SR)]
    expect(responseDb(p, 1000, SR)).toBeCloseTo(6, 1)
    expect(Math.abs(responseDb(p, 50, SR))).toBeLessThan(0.3)
  })

  it('shelves reach their gain at the extremes and are half-way at the corner', () => {
    expect(responseDb([lowShelf(200, -9, SR)], 20, SR)).toBeCloseTo(-9, 0)
    expect(responseDb([lowShelf(200, -9, SR)], 200, SR)).toBeCloseTo(-4.5, 0)
    expect(responseDb([highShelf(5000, 4, SR)], 18000, SR)).toBeGreaterThan(3.5)
    expect(Math.abs(responseDb([highShelf(5000, 4, SR)], 100, SR))).toBeLessThan(0.1)
  })

  it('a 0 dB band is perfectly flat', () => {
    for (const f of [30, 1000, 15000]) expect(responseDb([peaking(1000, 0, 2, SR)], f, SR)).toBeCloseTo(0, 6)
  })
})

describe('compressor curve', () => {
  it('passes below threshold and divides above it', () => {
    expect(compressorCurve(-40, -20, 4, 0)).toBe(-40)
    expect(compressorCurve(0, -20, 4, 0)).toBe(-15)
  })

  it('auto makeup is zero when bypassed and positive when compressing', () => {
    expect(compressorAutoMakeupDb(0, 1, 0)).toBeCloseTo(0)
    expect(compressorAutoMakeupDb(-20, 4, 0)).toBeCloseTo(9)
  })

  it('soft knee is continuous at its edges', () => {
    const lo = compressorCurve(-23, -20, 4, 6)
    const hi = compressorCurve(-17, -20, 4, 6)
    expect(lo).toBeCloseTo(-23, 6)
    expect(hi).toBeCloseTo(-20 + 3 / 4, 6)
  })
})

describe('strips and routing', () => {
  it('solo silences every other strip, mute always wins', () => {
    const a = createStrip(0, { solo: true })
    const b = createStrip(1)
    const c = createStrip(2, { solo: true, mute: true })
    const all = [a, b, c]
    expect(isAudible(a, all)).toBe(true)
    expect(isAudible(b, all)).toBe(false)
    expect(isAudible(c, all)).toBe(false)
    expect(stripOutputGain(b, all)).toBe(0)
    expect(stripOutputGain(a, all)).toBeCloseTo(1)
  })

  it('auto trim aims peaks at −12 dBFS and ignores silence', () => {
    expect(autoTrim(0, -30)).toBe(18)
    expect(autoTrim(6, -3)).toBe(-3)
    expect(autoTrim(0, -90)).toBeNull()
    expect(autoTrim(30, -60)).toBe(36)
  })

  it('fader floor is true silence', () => {
    expect(dbToGain(-60)).toBe(0)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
  })

  it('constant-power pan', () => {
    const c = panGains(0)
    expect(c.left).toBeCloseTo(Math.SQRT1_2)
    expect(c.left ** 2 + c.right ** 2).toBeCloseTo(1)
    expect(panGains(-1).right).toBeCloseTo(0)
    expect(panGains(5).left).toBeCloseTo(0)
  })

  it('fader taper round-trips and gives resolution near 0 dB', () => {
    for (const db of [-60, -30, -10, -3, 0, 6, 12]) expect(posToFader(faderToPos(db))).toBeCloseTo(db, 1)
    expect(faderToPos(0) - faderToPos(-10)).toBeGreaterThan(faderToPos(-10) - faderToPos(-30))
  })

  it('new strips only feed the internal recording bus (no feedback by default)', () => {
    expect(createStrip(0).sends).toEqual(['B1'])
    expect(routingWarnings(defaultMixer())).toEqual([])
  })

  it('warns about speakers, unrouted strips and too much digital gain', () => {
    const cfg = defaultMixer()
    cfg.strips = [createStrip(0, { name: 'Voz', sends: ['A1'] }), createStrip(1, { name: 'Nada', sends: [] }), createStrip(2, { name: 'Alto', trimDb: 20, faderDb: 10 })]
    const msgs = routingWarnings(cfg).map((w) => w.message).join('\n')
    expect(msgs).toMatch(/Voz suena por A1/)
    expect(msgs).toMatch(/Nada no está enviada/)
    expect(msgs).toMatch(/Alto tiene mucha ganancia/)
  })
})

describe('EQ response', () => {
  it('is flat with everything at 0 and shows the HPF', () => {
    const s = createStrip(0)
    expect(eqResponse(s, [50, 1000, 10000]).every((v) => v === 0)).toBe(true)
    const hp = eqResponse({ ...s, hpf: { on: true, hz: 120 } }, [30, 1000])
    expect(hp[0]).toBeLessThan(-15)
    expect(Math.abs(hp[1])).toBeLessThan(0.2)
  })

  it('log frequencies span the audio band', () => {
    const f = logFreqs(10)
    expect(f[0]).toBeCloseTo(20)
    expect(f[9]).toBeCloseTo(20000)
  })
})

describe('config persistence', () => {
  it('merges partial/old saves and drops sends to missing buses', () => {
    const m = mergeMixer({ strips: [{ name: 'Viejo', sends: ['A1', 'Z9'] } as never] })
    expect(m.strips[0].name).toBe('Viejo')
    expect(m.strips[0].sends).toEqual(['A1'])
    expect(m.strips[0].comp.ratio).toBe(3)
    expect(m.buses).toHaveLength(4)
    expect(mergeMixer(null)).toMatchObject({ buses: defaultMixer().buses })
  })

  it('scenes snapshot and restore strips', () => {
    let cfg = defaultMixer()
    cfg = saveScene(cfg, 'Podcast', 's1')
    cfg = { ...cfg, strips: [{ ...cfg.strips[0], faderDb: -20 }] }
    expect(loadScene(cfg, 's1').strips[0].faderDb).toBe(0)
    expect(loadScene(cfg, 'nope')).toBe(cfg)
  })

  it('round-trips the config file and rejects foreign ones', () => {
    const back = parseMixer(serializeMixer(saveScene(defaultMixer(), 'A')))
    expect(back.scenes).toHaveLength(1)
    expect(() => parseMixer('{"app":"x"}')).toThrow(/mezclador/)
    expect(() => parseMixer('nope')).toThrow(/JSON/)
  })
})
