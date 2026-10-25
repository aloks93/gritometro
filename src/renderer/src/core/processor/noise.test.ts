import { describe, expect, it } from 'vitest'
import { autoMakeupDb, Compressor, dbToLin, Gate, linToDb, saturate, Saturator } from './dynamics'
import { NoiseSuppressor, resampleProfile } from './noise'
import { comp1Defaults, gateDefaults, noiseDefaults, saturationDefaults } from './processor'

const SR = 48000

/** Deterministic white noise (LCG), RMS ≈ `db` dBFS */
function noise(db: number, seconds: number, seed = 1): Float32Array {
  let s = seed
  const a = dbToLin(db) * Math.sqrt(3)
  return Float32Array.from({ length: Math.round(SR * seconds) }, () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 2 ** 32 - 0.5) * 2 * a
  })
}

function sine(freq: number, db: number, seconds: number): Float32Array {
  const a = dbToLin(db)
  return Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => a * Math.sin((2 * Math.PI * freq * i) / SR))
}

function rmsDb(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += buf[i] * buf[i]
  return linToDb(Math.sqrt(s / Math.max(1, to - from)))
}

function run(p: { process: (b: Float32Array) => void }, buf: Float32Array): Float32Array {
  const out = buf.slice()
  for (let i = 0; i < out.length; i += 128) p.process(out.subarray(i, Math.min(out.length, i + 128)))
  return out
}

describe('noise suppressor', () => {
  it('switched off it is a pure delay of one frame (perfect reconstruction)', () => {
    for (const resolution of [512, 1024, 2048] as const) {
      const ns = new NoiseSuppressor(SR, { ...noiseDefaults(), on: false, resolution })
      const x = noise(-20, 0.5)
      const y = run(ns, x)
      const lat = ns.latency
      let err = 0
      for (let i = lat * 2; i < x.length; i++) err = Math.max(err, Math.abs(y[i] - x[i - lat]))
      expect(err).toBeLessThan(1e-5)
    }
  })

  it('removes steady noise by roughly the chosen amount (adaptive)', () => {
    const ns = new NoiseSuppressor(SR, { ...noiseDefaults(), on: true, reductionDb: -20 })
    const y = run(ns, noise(-40, 3))
    // After the tracker settles, the noise is close to 20 dB down
    expect(rmsDb(y, SR * 2) - -40).toBeLessThan(-14)
    expect(ns.reductionDb).toBeLessThan(-12)
  })

  it('keeps a voice-like tone above the noise', () => {
    const ns = new NoiseSuppressor(SR, { ...noiseDefaults(), on: true, reductionDb: -20 })
    const x = noise(-55, 3)
    // Syllable-like bursts: 300 ms on, 200 ms off (a steady endless tone *is* noise to the tracker)
    const tone = sine(1000, -20, 3).map((v, i) => ((i / SR) % 0.5 < 0.3 ? v : 0))
    for (let i = 0; i < x.length; i++) x[i] += tone[i]
    const y = run(ns, x)
    const lat = ns.latency
    // Middle of the last burst (2.5 … 2.8 s), compensating the one-frame delay
    const from = Math.round(SR * 2.55)
    const to = Math.round(SR * 2.75)
    expect(Math.abs(rmsDb(y, from + lat, to + lat) - rmsDb(tone, from, to))).toBeLessThan(1)
  })

  it('learns a profile from silence and uses it in learned mode', () => {
    const ns = new NoiseSuppressor(SR, { ...noiseDefaults(), on: true, mode: 'learned', reductionDb: -24 })
    ns.learn(0.5)
    run(ns, noise(-45, 0.6))
    expect(ns.learnedProfile).not.toBeNull()
    expect(ns.learnedProfile!.length).toBe(ns.bins)
    const y = run(ns, noise(-45, 1, 7))
    expect(rmsDb(y, SR * 0.5) - -45).toBeLessThan(-15)
  })

  it('listen mode outputs the removed part', () => {
    const ns = new NoiseSuppressor(SR, { ...noiseDefaults(), on: true, reductionDb: -30, listenRemoved: true })
    const y = run(ns, noise(-40, 3))
    // Almost all of pure noise is "removed"
    expect(rmsDb(y, SR * 2)).toBeGreaterThan(-43)
  })

  it('resamples a profile to another FFT size', () => {
    const r = resampleProfile([0, 10], 5)
    expect(Array.from(r)).toEqual([0, 2.5, 5, 7.5, 10])
  })
})

describe('processor extras', () => {
  it('gate key high-pass keeps rumble from opening the gate', () => {
    const p = { ...gateDefaults(), on: true, mode: 'gate' as const, thresholdDb: -30, rangeDb: -40, holdMs: 0, releaseMs: 10 }
    const plain = new Gate(SR, p)
    run(plain, sine(40, -12, 0.5))
    expect(plain.open).toBe(true)
    const keyed = new Gate(SR, { ...p, keyHpfHz: 300 })
    run(keyed, sine(40, -12, 0.5))
    expect(keyed.open).toBe(false)
  })

  it('compressor sidechain high-pass ignores low end; auto makeup restores level', () => {
    const p = { ...comp1Defaults(), on: true, thresholdDb: -30, ratio: 8, kneeDb: 0, makeupDb: 0, attackMs: 1 }
    const plain = new Compressor(SR, p)
    run(plain, sine(50, -6, 0.5))
    const sc = new Compressor(SR, { ...p, scHpfHz: 400 })
    run(sc, sine(50, -6, 0.5))
    expect(plain.blockGr).toBeLessThan(-15)
    expect(sc.blockGr).toBeGreaterThan(plain.blockGr + 10)
    expect(autoMakeupDb({ thresholdDb: -24, ratio: 4, kneeDb: 0 })).toBeCloseTo(4.5, 1)
    expect(autoMakeupDb({ thresholdDb: -10, ratio: 4, kneeDb: 0 })).toBe(0)
  })

  it('saturation is transparent for quiet signals and rounds off loud ones', () => {
    expect(saturate(0.001, dbToLin(12), 'tape')).toBeCloseTo(0.001, 5)
    expect(saturate(0.001, dbToLin(12), 'tube')).toBeCloseTo(0.001, 4)
    expect(Math.abs(saturate(1, dbToLin(12), 'tape'))).toBeLessThan(0.3)
    const s = new Saturator(SR, { ...saturationDefaults(), on: true, driveDb: 18, mix: 100, toneHz: 20000 })
    const y = run(s, sine(500, -3, 0.5))
    expect(rmsDb(y, SR * 0.2)).toBeLessThan(rmsDb(sine(500, -3, 0.5)) - 3)
  })
})
