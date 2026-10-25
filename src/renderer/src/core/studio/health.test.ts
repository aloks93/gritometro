import { describe, expect, it } from 'vitest'
import { alarmsOf, deviceChanges, evaluateHealth, levelHealth, LevelTracker, worstStatus, type HealthInput } from './health'

const quiet = { peakMaxDb: -30, clips: 0, silentForS: 0 }

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  now: 100000,
  engine: { status: 'running', label: 'Mic USB', sampleRate: 48000 },
  input: quiet,
  noiseFloorDb: -70,
  rmsDb: -40,
  splOffset: 110,
  overSplDb: 110,
  latencyMs: 20,
  calibrationWarnings: [],
  mixer: null,
  routingWarnings: [],
  generatorRunning: false,
  monitorOn: false,
  deviceEvents: [],
  ...over
})

describe('level tracker', () => {
  it('keeps a 3 s window of peaks and clips and counts silence', () => {
    const t = new LevelTracker()
    t.push(0, -0.05, true)
    t.push(1000, -20)
    expect(t.window(1000)).toMatchObject({ peakMaxDb: -0.05, clips: 1, silentForS: 0 })
    t.push(4000, -80)
    t.push(9000, -80)
    const w = t.window(9000)
    expect(w.clips).toBe(0)
    expect(w.peakMaxDb).toBe(-80)
    expect(w.silentForS).toBe(8)
    expect(new LevelTracker().window(0).silentForS).toBe(Infinity)
  })

  it('a signal that has always been quiet counts silence from the first reading', () => {
    const t = new LevelTracker()
    t.push(5000, -90)
    t.push(7000, -90)
    expect(t.window(7000).silentForS).toBe(2)
    expect(levelHealth(t.window(7000)).status).toBe('ok')
    t.push(16000, -90)
    expect(levelHealth(t.window(16000)).status).toBe('silence')
    expect(levelHealth({ peakMaxDb: -0.1, clips: 1, silentForS: 0 }).detail).toMatch(/1 vez /)
    expect(levelHealth({ peakMaxDb: -0.1, clips: 4, silentForS: 0 }).detail).toMatch(/4 veces/)
  })

  it('maps windows to lights: clip > hot > silence > ok', () => {
    expect(levelHealth({ peakMaxDb: -0.2, clips: 3, silentForS: 0 }).status).toBe('clip')
    expect(levelHealth({ peakMaxDb: -4, clips: 0, silentForS: 0 }).status).toBe('warning')
    expect(levelHealth({ peakMaxDb: -90, clips: 0, silentForS: 12 }).status).toBe('silence')
    expect(levelHealth({ peakMaxDb: -20, clips: 0, silentForS: 2 }).status).toBe('ok')
  })
})

describe('health evaluation', () => {
  it('all green on a healthy setup', () => {
    const items = evaluateHealth(base())
    expect(worstStatus(items)).toBe('ok')
    expect(alarmsOf(items)).toEqual([])
  })

  it('flags a disconnected mic, clipping, loud SPL, high latency and old calibration', () => {
    expect(worstStatus(evaluateHealth(base({ engine: { status: 'disconnected' } })))).toBe('clip')
    const items = evaluateHealth(base({ input: { peakMaxDb: 0, clips: 2, silentForS: 0 }, rmsDb: 5, latencyMs: 120, calibrationWarnings: ['vieja'] }))
    const byId = Object.fromEntries(items.map((i) => [i.id, i.status]))
    expect(byId).toMatchObject({ level: 'clip', spl: 'over', latency: 'warning', calib: 'warning' })
    expect(
      alarmsOf(items)
        .map((i) => i.id)
        .sort()
    ).toEqual(['level', 'spl'])
  })

  it('checks every mixer strip and bus, and surfaces routing warnings', () => {
    const items = evaluateHealth(
      base({
        mixer: {
          status: 'on',
          stripErrors: { b: 'Dispositivo no conectado.' },
          strips: [
            { id: 'a', name: 'Voz', muted: false, level: { peakMaxDb: -0.1, clips: 1, silentForS: 0 } },
            { id: 'b', name: 'Guitarra', muted: false, level: quiet },
            { id: 'c', name: 'Música', muted: true, level: quiet },
            { id: 'd', name: 'Ambiente', muted: false, level: { peakMaxDb: -90, clips: 0, silentForS: 30 } }
          ],
          buses: [{ id: 'A1', label: 'A1', name: 'Sala', limitingDb: -6, level: quiet }]
        },
        routingWarnings: ['Voz suena por A1']
      })
    )
    const byId = Object.fromEntries(items.map((i) => [i.id, i.status]))
    expect(byId).toMatchObject({ 'strip-a': 'clip', 'strip-b': 'clip', 'strip-c': 'off', 'strip-d': 'silence', 'bus-A1': 'warning', 'route-0': 'warning' })
  })

  it('reports devices plugged and unplugged in the last minute', () => {
    const ev = deviceChanges(['Mic A', 'Mic B'], ['Mic B', 'Interfaz'], 99000)
    expect(ev).toEqual([
      { t: 99000, text: 'Interfaz', kind: 'added' },
      { t: 99000, text: 'Mic A', kind: 'removed' }
    ])
    const items = evaluateHealth(base({ deviceEvents: ev }))
    expect(
      items
        .filter((i) => i.id.startsWith('dev-'))
        .map((i) => i.status)
        .sort()
    ).toEqual(['clip', 'ok'])
    expect(evaluateHealth(base({ deviceEvents: ev, now: 200000 })).some((i) => i.id.startsWith('dev-'))).toBe(false)
  })
})
