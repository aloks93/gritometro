import { describe, expect, it } from 'vitest'
import {
  applyMidi,
  applyPreset,
  createStrip,
  defaultMixer,
  gainAdvice,
  learnMidi,
  levelStatus,
  mergeMixer,
  monitorFeed,
  parseMixer,
  processingOf,
  routingWarnings,
  saveUserPreset,
  serializeMixer,
  type MixerConfig
} from './mixer'

describe('console defaults and old saves', () => {
  it('old configs get limiter, cue, monitor, meter point and user presets', () => {
    const old = { strips: [{ name: 'Viejo' }], buses: defaultMixer().buses } as unknown as Parameters<typeof mergeMixer>[0]
    const m = mergeMixer(old)
    expect(m.strips[0].limiter).toEqual({ on: false, ceilingDb: -3 })
    expect(m.strips[0].cue).toBe(false)
    expect(m.monitor.on).toBe(false)
    expect(m.meterPoint).toBe('post')
    expect(m.userPresets).toEqual([])
  })

  it('a monitor pointing at a deleted bus falls back to the first one', () => {
    const d = defaultMixer()
    const m = mergeMixer({ ...d, monitor: { ...d.monitor, source: 'Z9' } })
    expect(m.monitor.source).toBe(d.buses[0].id)
  })

  it('export/import keeps monitor, meter point and presets', () => {
    let cfg: MixerConfig = { ...defaultMixer(), meterPoint: 'pre' }
    cfg = { ...cfg, monitor: { ...cfg.monitor, on: true, levelDb: -10, source: 'B1' } }
    cfg = saveUserPreset(cfg, cfg.strips[0], 'Mi voz')
    const back = parseMixer(serializeMixer(cfg))
    expect(back.meterPoint).toBe('pre')
    expect(back.monitor).toMatchObject({ on: true, levelDb: -10, source: 'B1' })
    expect(back.userPresets.map((p) => p.name)).toEqual(['Mi voz'])
  })
})

describe('monitor / cue', () => {
  it('plays the source bus until a strip is cued, then only the cued strips', () => {
    const cfg = defaultMixer()
    const a = createStrip(0, { name: 'A' })
    const b = createStrip(1, { name: 'B' })
    expect(monitorFeed({ ...cfg, strips: [a, b] })).toEqual({ kind: 'bus', bus: 'A1' })
    expect(monitorFeed({ ...cfg, strips: [{ ...a, cue: true }, b] })).toEqual({ kind: 'cue', strips: [a.id] })
  })

  it('warns when a strip is cued but the monitor is off', () => {
    const cfg = defaultMixer()
    cfg.strips = [createStrip(0, { cue: true })]
    expect(routingWarnings(cfg).some((w) => /CUE/.test(w.message))).toBe(true)
    cfg.monitor = { ...cfg.monitor, on: true }
    expect(routingWarnings(cfg).some((w) => /CUE/.test(w.message))).toBe(false)
  })

  it('a MIDI button toggles cue', () => {
    let cfg = defaultMixer()
    cfg = learnMidi(cfg, 'note:1:40', 'stripCue', cfg.strips[0].id)
    cfg = applyMidi(cfg, { type: 'noteon', channel: 1, number: 40, value: 127 })
    expect(cfg.strips[0].cue).toBe(true)
  })
})

describe('gain staging', () => {
  it('classifies peaks like console LEDs', () => {
    expect(levelStatus(-0.2)).toBe('clip')
    expect(levelStatus(-4)).toBe('hot')
    expect(levelStatus(-15)).toBe('ok')
    expect(levelStatus(-45)).toBe('low')
    expect(levelStatus(-90)).toBe('silence')
  })

  it('blames the input first, then the processing', () => {
    expect(gainAdvice(-0.5, -0.5).status).toBe('clip')
    expect(gainAdvice(-0.5, -0.5).message).toMatch(/entrada/i)
    expect(gainAdvice(-15, -0.3).message).toMatch(/procesamiento/i)
    expect(gainAdvice(-50, -50).status).toBe('low')
    expect(gainAdvice(-100, -100).status).toBe('silence')
    expect(gainAdvice(-14, -10).status).toBe('ok')
  })
})

describe('user presets', () => {
  it('save the processing and apply it to another strip without touching its routing', () => {
    let cfg = defaultMixer()
    const src = { ...cfg.strips[0], hpf: { on: true, hz: 120 }, limiter: { on: true, ceilingDb: -6 }, notches: [{ hz: 2500, gainDb: -12, q: 30 }] }
    cfg = saveUserPreset(cfg, src, 'Sala')
    const target = createStrip(1, { name: 'Otro', faderDb: -8, sends: ['A1'] })
    const out = applyPreset(target, cfg.userPresets[0].id, cfg.userPresets)
    expect(out.hpf).toEqual({ on: true, hz: 120 })
    expect(out.limiter).toEqual({ on: true, ceilingDb: -6 })
    expect(out.notches).toHaveLength(1)
    expect(out.name).toBe('Otro')
    expect(out.faderDb).toBe(-8)
    expect(out.sends).toEqual(['A1'])
    // Detached: editing the strip later must not change the saved preset
    out.notches[0].hz = 100
    expect(cfg.userPresets[0].apply.notches?.[0].hz).toBe(2500)
  })

  it('saving with an existing name overwrites it', () => {
    let cfg = defaultMixer()
    cfg = saveUserPreset(cfg, cfg.strips[0], 'Voz')
    cfg = saveUserPreset(cfg, { ...cfg.strips[0], hpf: { on: true, hz: 150 } }, 'voz')
    expect(cfg.userPresets).toHaveLength(1)
    expect(cfg.userPresets[0].apply.hpf.hz).toBe(150)
    expect(processingOf(cfg.strips[0]).limiter).toEqual(cfg.strips[0].limiter)
  })
})
