import { describe, expect, it } from 'vitest'
import { ActivityTracker, chainSummary, channelKey, channelView, copyChannel, forgetChannel, parseChannelKey, resetChannel, setChannelInfo, storeCurrent, switchChannel } from './channels'
import { buildPreset, applyChain, defaultProcessor, mergeProcessor, type ProcessorConfig } from './processor'

const A = { deviceId: 'dev-a', channel: 0 }
const B = { deviceId: 'dev-a', channel: 1 }
const C = { deviceId: null, channel: -1 }

describe('per-channel setups', () => {
  it('keys are stable and reversible', () => {
    expect(channelKey(A)).toBe('dev-a#0')
    expect(channelKey(C)).toBe('default#-1')
    expect(parseChannelKey('dev-a#1')).toEqual(B)
    expect(parseChannelKey('default#-1')).toEqual(C)
  })

  it('switching stores the channel being edited and brings back the saved one', () => {
    let cfg = { ...applyChain({ ...defaultProcessor(), input: A }, buildPreset('podcast', 'dynamic')), inputGainDb: 9 }
    cfg = switchChannel(cfg, B, 1)
    // B is new: clean processing, unity gain
    expect(cfg.input).toEqual(B)
    expect(cfg.inputGainDb).toBe(0)
    expect(cfg.comp1.on).toBe(false)
    expect(cfg.channels['dev-a#0'].inputGainDb).toBe(9)
    // Work on B, then go back to A
    cfg = { ...cfg, inputGainDb: -3, gate: { ...cfg.gate, on: true, thresholdDb: -42 } }
    cfg = switchChannel(cfg, A, 2)
    expect(cfg.inputGainDb).toBe(9)
    expect(cfg.comp1.on).toBe(true)
    expect(cfg.channels['dev-a#1'].chain.gate.thresholdDb).toBe(-42)
    // …and B again, exactly as it was left
    cfg = switchChannel(cfg, B, 3)
    expect(cfg.inputGainDb).toBe(-3)
    expect(cfg.gate.thresholdDb).toBe(-42)
  })

  it('an untouched channel is not stored when leaving it', () => {
    const cfg = switchChannel({ ...defaultProcessor(), input: C }, A)
    expect(cfg.channels).toEqual({})
    const touched = switchChannel({ ...defaultProcessor(), input: C, inputGainDb: 3 }, A)
    expect(Object.keys(touched.channels)).toEqual(['default#-1'])
  })

  it('output, monitor and presets are not per channel', () => {
    let cfg: ProcessorConfig = { ...defaultProcessor(), input: A, output: { deviceId: 'vm', mute: false }, monitor: { on: true, deviceId: 'hp', levelDb: -3 } }
    cfg = switchChannel(cfg, B)
    expect(cfg.output.deviceId).toBe('vm')
    expect(cfg.monitor.on).toBe(true)
  })

  it('names, copies, resets and forgets', () => {
    let cfg = { ...applyChain({ ...defaultProcessor(), input: A }, buildPreset('stream', 'usb')), inputGainDb: 6 }
    cfg = setChannelInfo(cfg, 'dev-a#1', { name: 'Invitado' })
    expect(cfg.channels['dev-a#1'].name).toBe('Invitado')
    // Copy the loaded A onto B (not loaded): B keeps its name
    cfg = copyChannel(cfg, 'dev-a#0', 'dev-a#1')
    expect(cfg.channels['dev-a#1'].name).toBe('Invitado')
    expect(cfg.channels['dev-a#1'].inputGainDb).toBe(6)
    expect(cfg.channels['dev-a#1'].chain.noise.on).toBe(true)
    // Reset the loaded channel: applies at once
    cfg = resetChannel(cfg, 'dev-a#0')
    expect(cfg.inputGainDb).toBe(0)
    expect(cfg.noise.on).toBe(false)
    cfg = forgetChannel(cfg, 'dev-a#1')
    expect(cfg.channels['dev-a#1']).toBeUndefined()
  })

  it('the loaded channel shows live values; summary lists the active modules', () => {
    const cfg = storeCurrent({ ...applyChain({ ...defaultProcessor(), input: A }, buildPreset('podcast', 'dynamic')), inputGainDb: 2 })
    const live = channelView({ ...cfg, inputGainDb: 5 }, 'dev-a#0')
    expect(live?.inputGainDb).toBe(5)
    expect(channelView(cfg, 'nothing#0')).toBeNull()
    const s = chainSummary(cfg.channels['dev-a#0'])
    expect(s).toContain('Comp 1')
    expect(s).toContain('Limitador')
    expect(s.some((x) => x.startsWith('EQ '))).toBe(true)
  })

  it('old saves without channels load fine and bad entries are dropped', () => {
    const m = mergeProcessor({ channels: { 'dev#0': { name: 'X', inputGainDb: 99 } as never, nope: {} as never } })
    expect(Object.keys(m.channels)).toEqual(['dev#0'])
    expect(m.channels['dev#0'].inputGainDb).toBe(36)
    expect(m.channels['dev#0'].chain.limiter.on).toBe(true)
    expect(mergeProcessor({}).channels).toEqual({})
  })
})

describe('activity tracker', () => {
  it('needs sustained signal, holds it, and flags clipping', () => {
    const t = new ActivityTracker(-50, 1000)
    expect(t.update(-30, -20, 50).signal).toBe(false)
    let a = t.update(-30, -20, 50)
    a = t.update(-30, -20, 60)
    expect(a.signal).toBe(true)
    a = t.update(-90, -80, 500)
    expect(a.signal).toBe(true)
    a = t.update(-90, -80, 600)
    expect(a.signal).toBe(false)
    expect(t.update(-10, 0, 20).clip).toBe(true)
  })
})
