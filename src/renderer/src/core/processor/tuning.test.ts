import { describe, expect, it } from 'vitest'
import { detectPitch } from '../studio/pitch'
import { midiHz, midiName, nearestString, PitchSmoother, TUNINGS, tunerMinHz } from './tuning'

const SR = 48000
const tuning = (id: string) => TUNINGS.find((t) => t.id === id)!

/** A plucked-string-like tone: fundamental plus decaying harmonics */
function pluck(hz: number, n = 4096): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => {
    const t = i / SR
    return 0.3 * Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(4 * Math.PI * hz * t) + 0.1 * Math.sin(6 * Math.PI * hz * t)
  })
}

describe('instrument tuner', () => {
  it('string notes match standard tunings', () => {
    expect(midiHz(69)).toBeCloseTo(440)
    expect(midiHz(28)).toBeCloseTo(41.2, 1)
    expect(midiName(28)).toBe('Mi1')
    expect(tuning('bass4').strings.map(midiName)).toEqual(['Mi1', 'La1', 'Re2', 'Sol2'])
    expect(tuning('guitar').strings.map(midiName)).toEqual(['Mi2', 'La2', 'Re3', 'Sol3', 'Si3', 'Mi4'])
    expect(midiHz(tuning('bass5').strings[0])).toBeCloseTo(30.87, 1)
  })

  it('finds the nearest string and how far off it is', () => {
    const s = nearestString(110 * Math.pow(2, -20 / 1200), tuning('guitar'))!
    expect(s.name).toBe('La2')
    expect(s.index).toBe(1)
    expect(s.cents).toBeCloseTo(-20, 1)
    // A badly flat string still maps to itself, beyond −50 cents
    expect(nearestString(36, tuning('bass4'))!.name).toBe('Mi1')
    expect(nearestString(36, tuning('bass4'))!.cents).toBeLessThan(-50)
    expect(nearestString(440, tuning('chromatic'))).toBeNull()
    expect(nearestString(440, tuning('bass4'), 432)!.targetHz).toBeCloseTo(96.2, 1)
  })

  it('detects the low strings of a bass on the tuner window', () => {
    for (const midi of [23, 28, 33]) {
      const hz = midiHz(midi)
      const p = detectPitch(pluck(hz), SR, tunerMinHz(tuning('bass5')), 1500, 0.12)
      expect(p, `midi ${midi}`).not.toBeNull()
      expect(Math.abs(1200 * Math.log2(p!.hz / hz))).toBeLessThan(5)
    }
    expect(tunerMinHz(tuning('bass5'))).toBeLessThan(31)
    expect(tunerMinHz(tuning('guitar'))).toBeGreaterThan(60)
  })

  it('smoother takes the median and restarts on a new note', () => {
    const sm = new PitchSmoother(5)
    for (const hz of [110, 110.5, 140, 110.2, 109.8]) sm.push(hz)
    // The 140 Hz outlier is far from the median, so it restarted the history once
    expect(sm.value()).toBeCloseTo(110.2, 0)
    sm.push(220)
    expect(sm.value()).toBe(220)
  })
})
