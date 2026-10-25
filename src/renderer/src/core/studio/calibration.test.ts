import { describe, expect, it } from 'vitest'
import { calibrationWarnings, checkCalibratorSignal, gainAdvice, loopbackResult, pushCalibration, verifyAgainstReference, type CalibrationRecord } from './calibration'
import { mergeStudio } from './studio'

const steady = (db: number, n = 30, jitter = 0.1): number[] => Array.from({ length: n }, (_, i) => db + (i % 2 ? jitter : -jitter))

describe('calibrator signal check', () => {
  it('accepts a steady 1 kHz tone and reports its level', () => {
    const c = checkCalibratorSignal(steady(-26), 1002, -20)
    expect(c.ok).toBe(true)
    expect(c.levelDbfs).toBeCloseTo(-26, 1)
    expect(c.spreadDb).toBeCloseTo(0.2, 5)
  })

  it('rejects unsteady, quiet, clipped or wrong-frequency signals with reasons', () => {
    expect(checkCalibratorSignal(steady(-26, 30, 1), 1000).problems.join()).toMatch(/varía/)
    expect(checkCalibratorSignal(steady(-80), 1000).problems.join()).toMatch(/baja/)
    expect(checkCalibratorSignal(steady(-3), 1000, -0.1).problems.join()).toMatch(/satura/)
    expect(checkCalibratorSignal(steady(-26), 250).problems.join()).toMatch(/250 Hz/)
    expect(checkCalibratorSignal([-26, -26], 1000).ok).toBe(false)
  })
})

describe('verification against the reference', () => {
  it('passes inside the class tolerance and fails outside', () => {
    expect(verifyAgainstReference(94.8, 94, 1).pass).toBe(true)
    expect(verifyAgainstReference(95.3, 94, 1).pass).toBe(false)
    expect(verifyAgainstReference(95.3, 94, 2).pass).toBe(true)
    const v = verifyAgainstReference(92.1, 94, 2)
    expect(v.deviationDb).toBe(-1.9)
    expect(v.message).toMatch(/Fuera/)
  })
})

describe('calibration history and warnings', () => {
  const rec = (id: string, atIso = '2026-10-20T10:00:00Z'): CalibrationRecord => ({ id, atIso, method: 'calibrator', offsetDb: 120, deviceLabel: 'Mic A', gainDb: 0 })

  it('keeps newest first and caps the list', () => {
    let h: CalibrationRecord[] = []
    for (let i = 0; i < 20; i++) h = pushCalibration(h, rec(`c${i}`))
    expect(h).toHaveLength(12)
    expect(h[0].id).toBe('c19')
  })

  it('warns about missing, old, swapped-device, regained or hand-edited calibrations', () => {
    const now = new Date('2026-10-25T10:00:00Z')
    expect(calibrationWarnings(undefined, { gainDb: 0, offsetDb: 110 }, now)[0]).toMatch(/no está calibrado/)
    expect(calibrationWarnings(rec('a'), { deviceLabel: 'Mic A', gainDb: 0, offsetDb: 120 }, now)).toEqual([])
    const all = calibrationWarnings(rec('a', '2026-08-01T00:00:00Z'), { deviceLabel: 'Mic B', gainDb: 6, offsetDb: 118 }, now).join(' | ')
    expect(all).toMatch(/días/)
    expect(all).toMatch(/Mic B/)
    expect(all).toMatch(/ganancia/)
    expect(all).toMatch(/a mano/)
  })

  it('old studio saves get an empty calibration map and class 2', () => {
    const s = mergeStudio({ candidates: [] })
    expect(s.calibrations).toEqual({})
    expect(s.toleranceClass).toBe(2)
  })
})

describe('loopback', () => {
  it('reports chain gain at 1 kHz and flatness relative to it', () => {
    const r = loopbackResult([
      { hz: 100, sentDbfs: -20, receivedDbfs: -22.5 },
      { hz: 1000, sentDbfs: -20, receivedDbfs: -22 },
      { hz: 10000, sentDbfs: -20, receivedDbfs: -23 }
    ])!
    expect(r.gainDb).toBe(-2)
    expect(r.response.find((p) => p.hz === 10000)?.db).toBe(-1)
    expect(r.flatnessDb).toBe(1)
    expect(r.message).toMatch(/pierde 2 dB/)
    expect(loopbackResult([{ hz: 1000, sentDbfs: -20, receivedDbfs: -200 }])).toBeNull()
  })
})

describe('gain advice', () => {
  it('raises a quiet input, lowers a hot one and blames a noisy room', () => {
    expect(gainAdvice(-80, -30)).toMatchObject({ status: 'raise', changeDb: 18 })
    expect(gainAdvice(-80, -0.2).status).toBe('lower')
    expect(gainAdvice(-80, -4)).toMatchObject({ status: 'lower', changeDb: -8 })
    expect(gainAdvice(-45, -25).status).toBe('noisy')
    expect(gainAdvice(-75, -13)).toMatchObject({ status: 'ok', changeDb: 0 })
  })
})
