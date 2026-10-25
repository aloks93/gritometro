import { describe, expect, it } from 'vitest'
import { measureRt60 } from './acoustics'
import { distortionVerdict, fft, measureDistortion } from './distortion'
import { rng } from './dsp'
import { balanceDb, channelOffset, correlationVerdict, goniometer, offsetToCm, phaseCorrelation } from './stereo'

const SR = 48000

function tone(hz: number, seconds: number, amp = 0.5, harmonics: [number, number][] = [], noise = 0): Float32Array {
  const r = rng(3)
  const out = new Float32Array(Math.round(SR * seconds))
  for (let i = 0; i < out.length; i++) {
    let v = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    for (const [k, rel] of harmonics) v += amp * rel * Math.sin((2 * Math.PI * hz * k * i) / SR)
    out[i] = v + (noise ? (r() * 2 - 1) * noise : 0)
  }
  return out
}

describe('FFT', () => {
  it('puts a bin-centred cosine in its bin', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / n)
    fft(re, im)
    expect(re[5]).toBeCloseTo(n / 2, 6)
    expect(Math.abs(re[6])).toBeLessThan(1e-9)
  })
})

describe('THD / THD+N', () => {
  it('a clean sine reads near zero distortion at the right frequency and level', () => {
    const d = measureDistortion(tone(1000, 1, 0.5), SR)!
    expect(d.fundamentalHz).toBeGreaterThan(999)
    expect(d.fundamentalHz).toBeLessThan(1001)
    expect(d.fundamentalDb).toBeCloseTo(-6, 0)
    expect(d.thdPct).toBeLessThan(0.01)
  })

  it('1 % second harmonic reads as 1 % THD and −40 dBc', () => {
    const d = measureDistortion(tone(1000, 1, 0.5, [[2, 0.01]]), SR, 1000)!
    expect(d.thdPct).toBeGreaterThan(0.9)
    expect(d.thdPct).toBeLessThan(1.1)
    expect(d.harmonics[0]).toMatchObject({ k: 2, hz: 2000 })
    expect(d.harmonics[0].dbc).toBeCloseTo(-40, 0)
  })

  it('noise raises THD+N but not THD', () => {
    const d = measureDistortion(tone(1000, 1, 0.5, [], 0.01), SR, 1000)!
    expect(d.thdnPct).toBeGreaterThan(d.thdPct * 3)
    expect(d.sinadDb).toBeCloseTo(-d.thdnDb, 5)
  })

  it('no tone, no result', () => {
    const r = rng(5)
    const noise = Float32Array.from({ length: SR }, () => r() * 2 - 1)
    expect(measureDistortion(noise, SR)).toBeNull()
    expect(measureDistortion(new Float32Array(100), SR)).toBeNull()
    expect(distortionVerdict(0.005)).toMatch(/Excelente/)
    expect(distortionVerdict(8)).toMatch(/Muy alta/)
  })
})

describe('stereo / phase', () => {
  const a = tone(440, 0.1, 0.5, [], 0.2)

  it('identical channels correlate +1, inverted −1, silence 0', () => {
    const inv = a.map((v) => -v)
    expect(phaseCorrelation(a, a)).toBeCloseTo(1, 6)
    expect(phaseCorrelation(a, inv)).toBeCloseTo(-1, 6)
    expect(phaseCorrelation(a, new Float32Array(a.length))).toBe(0)
    expect(correlationVerdict(-0.8)).toMatch(/invertida/)
  })

  it('balance is the level difference', () => {
    expect(balanceDb(a, a.map((v) => v / 2))).toBeCloseTo(-6, 0)
    expect(balanceDb(new Float32Array(4), new Float32Array(4))).toBe(0)
  })

  it('finds the delay and the polarity between two mics', () => {
    const r = rng(9)
    const src = Float32Array.from({ length: 4096 }, () => r() * 2 - 1)
    const late = new Float32Array(4096)
    late.set(src.subarray(0, 4096 - 96), 96)
    const off = channelOffset(src, late, SR, 480)!
    expect(off.lag).toBe(96)
    expect(off.ms).toBeCloseTo(2, 1)
    expect(off.inverted).toBe(false)
    expect(offsetToCm(off.ms)).toBeCloseTo(68.6, 0)
    const inv = channelOffset(src, late.map((v) => -v), SR, 480)!
    expect(inv.lag).toBe(96)
    expect(inv.inverted).toBe(true)
    expect(channelOffset(src, new Float32Array(4096), SR, 100)).toBeNull()
  })

  it('goniometer: mono is vertical, inverted is horizontal', () => {
    const out = new Float32Array(8)
    goniometer([0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], out)
    expect(out[0]).toBeCloseTo(0)
    expect(out[1]).toBeGreaterThan(0.7)
    goniometer([0.5], [-0.5], out)
    expect(Math.abs(out[0])).toBeGreaterThan(0.7)
    expect(out[1]).toBeCloseTo(0)
  })
})

describe('RT60 from interrupted noise', () => {
  it('measures the decay of a synthetic room', () => {
    // 0.5 s of noise, then an exponential decay with RT60 = 0.6 s, then a quiet floor
    const r = rng(2)
    const pcm = new Float32Array(SR * 2)
    const rt = 0.6
    for (let i = 0; i < pcm.length; i++) {
      const t = i / SR - 0.5
      const env = t < 0 ? 1 : Math.pow(10, (-60 * t) / rt / 20)
      pcm[i] = (r() * 2 - 1) * env + (r() * 2 - 1) * 1e-4
    }
    const res = measureRt60(pcm.subarray(Math.round(SR * 0.45)), SR)
    expect(res.t20).not.toBeNull()
    expect(res.t20!).toBeGreaterThan(0.5)
    expect(res.t20!).toBeLessThan(0.7)
  })
})
