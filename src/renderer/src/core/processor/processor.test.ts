import { describe, expect, it } from 'vitest'
import { Compressor, DeEsser, Gate, Limiter, dbToLin, linToDb, lookaheadSamples } from './dynamics'
import {
  autoSetup,
  band,
  bandStages,
  buildPreset,
  comp1Defaults,
  deesserDefaults,
  defaultProcessor,
  eqCurve,
  gateDefaults,
  IDENTITY,
  MICS,
  mergeProcessor,
  parsePreset,
  processorWarnings,
  saveUserPreset,
  serializePreset,
  STAGES_PER_BAND,
  USES
} from './processor'

const SR = 48000

function sine(freq: number, db: number, seconds = 0.5): Float32Array {
  const a = dbToLin(db)
  return Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => a * Math.sin((2 * Math.PI * freq * i) / SR))
}

function peakDb(buf: Float32Array, from = 0): number {
  let p = 0
  for (let i = from; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]))
  return linToDb(p)
}

/** Runs a processor over the buffer in 128-sample blocks, like an AudioWorklet */
function run(p: { process: (b: Float32Array) => void }, buf: Float32Array): Float32Array {
  const out = buf.slice()
  for (let i = 0; i < out.length; i += 128) p.process(out.subarray(i, Math.min(out.length, i + 128)))
  return out
}

describe('processor EQ', () => {
  it('a peaking band gives its gain at the centre and nothing far away', () => {
    const eq = { on: true, bands: [band('peaking', 1000, 6, 1)] }
    const [atF, far] = eqCurve(eq, [1000, 50])
    expect(atF).toBeCloseTo(6, 1)
    expect(Math.abs(far)).toBeLessThan(0.2)
  })

  it('high-pass slopes: 12 dB/oct ≈ −12 dB an octave below, 48 dB/oct ≈ −48 dB', () => {
    for (const slope of [12, 24, 48] as const) {
      const eq = { on: true, bands: [band('highpass', 200, 0, 0.71, true, slope)] }
      const [cut, corner, pass] = eqCurve(eq, [100, 200, 2000])
      expect(cut).toBeLessThan(-slope + 2)
      expect(cut).toBeGreaterThan(-slope - 2)
      expect(corner).toBeCloseTo(-3, 0)
      expect(Math.abs(pass)).toBeLessThan(0.1)
    }
  })

  it('shelves, notch and band-pass behave as Web Audio filters', () => {
    expect(eqCurve({ on: true, bands: [band('lowshelf', 200, -6)] }, [20])[0]).toBeCloseTo(-6, 0)
    expect(eqCurve({ on: true, bands: [band('highshelf', 5000, 4)] }, [18000])[0]).toBeCloseTo(4, 0)
    expect(eqCurve({ on: true, bands: [band('notch', 1000, 0, 4)] }, [1000])[0]).toBeLessThan(-40)
    expect(eqCurve({ on: true, bands: [band('bandpass', 1000, 0, 2)] }, [1000])[0]).toBeCloseTo(0, 1)
  })

  it('every band always uses the same number of stages, unused ones are pass-through', () => {
    const stages = bandStages(band('peaking', 1000, 3), true, SR)
    expect(stages).toHaveLength(STAGES_PER_BAND)
    expect(stages.slice(1).every((s) => s === IDENTITY)).toBe(true)
    expect(bandStages(band('highpass', 80, 0, 0.71, true, 48), true, SR).every((s) => s.type === 'highpass')).toBe(true)
    expect(bandStages(band('peaking', 1000, 6), false, SR).every((s) => s === IDENTITY)).toBe(true)
    expect(eqCurve({ on: false, bands: [band('peaking', 1000, 12)] }, [1000])[0]).toBe(0)
  })
})

describe('processor dynamics', () => {
  it('gate closes on quiet signals and opens on loud ones', () => {
    const g = new Gate(SR, { ...gateDefaults(), on: true, mode: 'gate', thresholdDb: -40, rangeDb: -40, holdMs: 10, releaseMs: 20 })
    const quiet = run(g, sine(500, -60))
    expect(peakDb(quiet, SR * 0.3)).toBeLessThan(-95)
    expect(g.open).toBe(false)
    const loud = run(g, sine(500, -20))
    expect(peakDb(loud, SR * 0.1)).toBeCloseTo(-20, 0)
    expect(g.open).toBe(true)
  })

  it('expander pushes signals below the threshold down by the ratio', () => {
    const g = new Gate(SR, { ...gateDefaults(), on: true, mode: 'expander', thresholdDb: -40, ratio: 2, rangeDb: -30, holdMs: 0 })
    // 10 dB under the threshold at 1:2 → another 10 dB down
    const out = run(g, sine(500, -50, 1))
    expect(peakDb(out, SR * 0.6)).toBeLessThan(-57)
    expect(peakDb(out, SR * 0.6)).toBeGreaterThan(-63)
  })

  it('compressor reaches the static curve and adds makeup', () => {
    const c = new Compressor(SR, { ...comp1Defaults(), on: true, thresholdDb: -20, ratio: 4, kneeDb: 0, makeupDb: 0, attackMs: 1, releaseMs: 50 })
    // −8 dBFS peak: 12 dB over at 4:1 → 9 dB of reduction → about −17 dBFS
    const out = run(c, sine(1000, -8, 1))
    expect(peakDb(out, SR * 0.5)).toBeGreaterThan(-18.5)
    expect(peakDb(out, SR * 0.5)).toBeLessThan(-15.5)
    expect(c.blockGr).toBeLessThan(-7)
    const m = new Compressor(SR, { ...comp1Defaults(), on: true, thresholdDb: 0, ratio: 4, makeupDb: 6 })
    expect(peakDb(run(m, sine(1000, -20)), SR * 0.2)).toBeCloseTo(-14, 0)
  })

  it('parallel mix blends dry and compressed signal', () => {
    const p = { ...comp1Defaults(), on: true, thresholdDb: -30, ratio: 20, kneeDb: 0, makeupDb: 0, attackMs: 1 }
    const full = peakDb(run(new Compressor(SR, { ...p, mix: 100 }), sine(1000, -6)), SR * 0.3)
    const half = peakDb(run(new Compressor(SR, { ...p, mix: 50 }), sine(1000, -6)), SR * 0.3)
    expect(half).toBeGreaterThan(full + 6)
    expect(half).toBeLessThan(-6)
  })

  it('de-esser turns sibilance down and leaves the body of the voice alone', () => {
    const p = { ...deesserDefaults(), on: true, freq: 6500, thresholdDb: -40, rangeDb: -10 }
    const hi = peakDb(run(new DeEsser(SR, p), sine(7000, -12)), SR * 0.3)
    const lo = peakDb(run(new DeEsser(SR, p), sine(300, -12)), SR * 0.3)
    expect(hi).toBeLessThan(-18)
    expect(lo).toBeGreaterThan(-13)
  })

  it('limiter never lets a sample through above the ceiling and delays by the look-ahead', () => {
    const lim = new Limiter(SR, { on: true, ceilingDb: -1, releaseMs: 50 })
    const loud = sine(1000, 6)
    const out = run(lim, loud)
    expect(peakDb(out)).toBeLessThanOrEqual(-1 + 1e-6)
    expect(lim.blockGr).toBeLessThan(-6)
    // Off: same signal, just delayed
    const off = new Limiter(SR, { on: false, ceilingDb: -1, releaseMs: 50 })
    const imp = new Float32Array(256)
    imp[0] = 1
    const d = run(off, imp)
    expect(d.indexOf(1)).toBe(lookaheadSamples(SR))
  })
})

describe('processor config', () => {
  it('merges old or partial saves with defaults', () => {
    const m = mergeProcessor({ inputGainDb: 99, eq: { on: true, bands: [band('peaking', 1000, 3)] }, comp1: { on: true } as never })
    expect(m.inputGainDb).toBe(36)
    expect(m.eq.bands).toHaveLength(1)
    expect(m.comp1.ratio).toBe(comp1Defaults().ratio)
    expect(m.limiter.on).toBe(true)
    expect(mergeProcessor(null)).toEqual(defaultProcessor())
  })

  it('every use × mic preset is a valid chain with sane values', () => {
    for (const u of USES) {
      for (const mic of MICS) {
        const c = buildPreset(u.id, mic.id)
        expect(c.eq.bands).toHaveLength(8)
        expect(c.eq.bands.every((b) => Math.abs(b.gainDb) <= 8 && b.freq >= 20 && b.freq <= 20000)).toBe(true)
        expect(c.limiter.on).toBe(true)
      }
    }
    // The mic type changes the EQ
    expect(buildPreset('speech', 'lavalier').eq.bands[4].gainDb).toBeGreaterThan(buildPreset('speech', 'condenser').eq.bands[4].gainDb)
  })

  it('user presets save, overwrite by name and survive a file round trip', () => {
    let cfg = saveUserPreset(defaultProcessor(), 'Mi voz', 'a')
    cfg = saveUserPreset({ ...cfg, inputGainDb: 5, comp1: { ...cfg.comp1, ratio: 8 } }, 'mi voz', 'b')
    expect(cfg.userPresets).toHaveLength(1)
    expect(cfg.userPresets[0].apply.comp1.ratio).toBe(8)
    const back = parsePreset(serializePreset('Mi voz', cfg.userPresets[0].apply))
    expect(back.chain.comp1.ratio).toBe(8)
    expect(() => parsePreset('{"app":"otra"}')).toThrow()
  })

  it('auto setup sets peaks to −12 dBFS and places the gate between noise and voice', () => {
    const cfg = defaultProcessor()
    const r = autoSetup(cfg, { noiseDb: -70, peakDb: -24, speechDb: -40 })
    expect(r.patch.inputGainDb).toBe(12)
    // noise −58, voice −28 after +12 dB
    expect(r.patch.gate!.on).toBe(true)
    expect(r.patch.gate!.thresholdDb).toBeGreaterThan(-58 + 5)
    expect(r.patch.gate!.thresholdDb).toBeLessThan(-28 - 7)
    expect(r.patch.comp1!.thresholdDb).toBe(-24)
    expect(autoSetup(cfg, { noiseDb: -40, peakDb: -20, speechDb: -35 }).patch.gate!.on).toBe(false)
    expect(autoSetup(cfg, { noiseDb: -90, peakDb: -90, speechDb: -90 }).patch).toEqual({})
  })

  it('auto setup corrects a muddy voice', () => {
    const r = autoSetup(defaultProcessor(), { noiseDb: -70, peakDb: -12, speechDb: -30, regions: { low: 20, mud: 30, box: 15, presence: 0, air: -12 } })
    expect(r.patch.eq!.bands[2].gainDb).toBeLessThan(-2)
    // A voice already on target is left alone
    const flat = autoSetup(defaultProcessor(), { noiseDb: -70, peakDb: -12, speechDb: -30, regions: { low: 20, mud: 21, box: 15, presence: 0, air: -12 } })
    expect(flat.patch.eq!.bands.every((b) => b.gainDb === 0)).toBe(true)
  })

  it('warns about speakers, doubled monitoring and bypass', () => {
    const cfg = defaultProcessor()
    expect(processorWarnings(cfg, 'Altavoces (Realtek)', null).length).toBe(1)
    expect(processorWarnings(cfg, 'VoiceMeeter Input (VB-Audio VoiceMeeter VAIO)', null)).toEqual([])
    const both = processorWarnings({ ...cfg, bypass: true, monitor: { on: true, deviceId: null, levelDb: 0 } }, 'VoiceMeeter Input', 'VoiceMeeter Input')
    expect(both.length).toBe(3)
  })
})

