import { describe, expect, it } from 'vitest'
import { addAuxBus, createStrip, defaultMixer, learnMidi, MAX_AUX_BUSES, mergeMixer, removeBus, routingWarnings, sendGain } from './mixer'

describe('aux (C) buses', () => {
  it('adds C1, C2… as pre-fader outputs, up to the limit', () => {
    let cfg = defaultMixer()
    cfg = addAuxBus(cfg)
    cfg = addAuxBus(cfg)
    const aux = cfg.buses.filter((b) => b.custom)
    expect(aux.map((b) => b.id)).toEqual(['C1', 'C2'])
    expect(aux.every((b) => b.pre && b.kind === 'out')).toBe(true)
    for (let i = 0; i < 10; i++) cfg = addAuxBus(cfg)
    expect(cfg.buses.filter((b) => b.custom)).toHaveLength(MAX_AUX_BUSES)
  })

  it('reuses a free number after removing one', () => {
    let cfg = addAuxBus(addAuxBus(defaultMixer()))
    cfg = removeBus(cfg, 'C1')
    expect(addAuxBus(cfg).buses.filter((b) => b.custom).map((b) => b.id)).toEqual(['C2', 'C1'])
  })

  it('removing a bus drops its sends, MIDI maps and monitor source; built-in buses stay', () => {
    let cfg = addAuxBus(defaultMixer())
    cfg = { ...cfg, strips: [createStrip(0, { sends: ['B1', 'C1'] })], monitor: { ...cfg.monitor, source: 'C1' } }
    cfg = learnMidi(cfg, 'cc:1:9', 'busFader', 'C1')
    const out = removeBus(cfg, 'C1')
    expect(out.buses.some((b) => b.id === 'C1')).toBe(false)
    expect(out.strips[0].sends).toEqual(['B1'])
    expect(out.midi).toEqual([])
    expect(out.monitor.source).toBe('A1')
    expect(removeBus(out, 'A1')).toBe(out)
  })

  it('pre-fader sends ignore fader and solo but follow mute', () => {
    const pre = { id: 'C1', pre: true }
    const post = { id: 'A1', pre: false }
    const s = createStrip(0, { sends: ['C1', 'A1'], faderDb: -60, solo: false })
    expect(sendGain(s, pre)).toBe(1)
    expect(sendGain(s, post)).toBe(1)
    expect(sendGain({ ...s, mute: true }, pre)).toBe(0)
    expect(sendGain({ ...s, sends: [] }, pre)).toBe(0)
  })

  it('survives a save/load and is checked like any output', () => {
    const cfg = addAuxBus(defaultMixer())
    const back = mergeMixer(JSON.parse(JSON.stringify(cfg)))
    expect(back.buses.find((b) => b.id === 'C1')).toMatchObject({ pre: true, custom: true })
    const withSend = { ...back, strips: [createStrip(0, { sends: ['C1'] })] }
    expect(routingWarnings(withSend).some((w) => /C1/.test(w.message))).toBe(true)
  })
})
