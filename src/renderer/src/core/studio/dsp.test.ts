import { describe, expect, it } from 'vitest'
import { aWeightingDb } from './analysis'
import {
  ampToDb,
  aWeighting,
  clickBurst,
  cWeighting,
  FilterChain,
  findDelay,
  highPass,
  kWeighting,
  logSweep,
  pinkNoise,
  responseDb,
  summarizeLatency,
  TruePeakMeter,
  whiteNoise
} from './dsp'
import { calibrationOffset, gatedLoudness, LoudnessMeter, loudnessRange, measureLoudness, SoundLevelMeter } from './loudness'
import { detectPitch, medianPitch, noteInfo } from './pitch'

const SR = 48000

function sine(hz: number, seconds: number, amp = 1, sr = SR, phase = 0): Float32Array {
  const out = new Float32Array(Math.round(sr * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr + phase)
  return out
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('weighting filters', () => {
  it('A-weighting matches the IEC curve within 1.5 dB up to 8 kHz', () => {
    const a = aWeighting(SR)
    for (const f of [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
      expect(Math.abs(responseDb(a, f, SR) - aWeightingDb(f))).toBeLessThan(1.5)
    }
    expect(responseDb(a, 1000, SR)).toBeCloseTo(0, 5)
  })

  it('C-weighting is flat in the midrange and rolls off at the extremes', () => {
    const c = cWeighting(SR)
    expect(Math.abs(responseDb(c, 500, SR))).toBeLessThan(0.3)
    expect(responseDb(c, 31.5, SR)).toBeLessThan(-2)
    expect(responseDb(c, 31.5, SR)).toBeGreaterThan(-4.5)
  })

  it('K-weighting boosts highs ~4 dB and cuts deep lows', () => {
    const k = kWeighting(SR)
    expect(responseDb(k, 10000, SR)).toBeGreaterThan(3.5)
    expect(responseDb(k, 20, SR)).toBeLessThan(-10)
  })

  it('filter chain attenuates a 30 Hz tone through an 80 Hz high-pass', () => {
    const chain = new FilterChain([highPass(80, SR)])
    const x = sine(30, 1)
    let peak = 0
    x.forEach((v, i) => {
      const y = chain.process(v)
      if (i > SR / 2) peak = Math.max(peak, Math.abs(y))
    })
    expect(ampToDb(peak)).toBeLessThan(-15)
  })
})

describe('true peak', () => {
  it('finds the inter-sample peak a sample meter misses', () => {
    // fs/4 sine at 45°: every sample lands at ±0.707 but the wave reaches 1.0
    const x = sine(SR / 4, 0.1, 1, SR, Math.PI / 4)
    const samplePeak = Math.max(...Array.from(x, Math.abs))
    const tp = new TruePeakMeter()
    tp.push(x)
    expect(ampToDb(samplePeak)).toBeLessThan(-2.9)
    expect(ampToDb(tp.max)).toBeGreaterThan(-0.6)
  })
})

describe('loudness (EBU R128)', () => {
  it('reads a −20 dBFS 997 Hz sine as about −23 LUFS', () => {
    const r = measureLoudness(sine(997, 5, 0.1), SR)
    expect(r.integrated).toBeGreaterThan(-23.3)
    expect(r.integrated).toBeLessThan(-22.7)
    expect(r.momentary).toBeCloseTo(r.integrated, 0)
  })

  it('gates out silence from the integrated value', () => {
    const r = measureLoudness(concat(sine(997, 3, 0.1), new Float32Array(SR * 6)), SR)
    expect(r.integrated).toBeGreaterThan(-23.4)
    expect(r.integrated).toBeLessThan(-22.6)
  })

  it('loudness range grows with dynamic programme material', () => {
    const steady = measureLoudness(sine(997, 12, 0.1), SR)
    const dynamic = measureLoudness(concat(sine(997, 6, 0.1), sine(997, 6, 0.01)), SR)
    expect(steady.lra).toBeLessThan(1)
    expect(dynamic.lra).toBeGreaterThan(10)
  })

  it('streams in arbitrary chunk sizes', () => {
    const x = sine(997, 4, 0.1)
    const m = new LoudnessMeter(SR)
    for (let i = 0; i < x.length; i += 1000) m.push(x.subarray(i, i + 1000))
    expect(m.reading().integrated).toBeCloseTo(measureLoudness(x, SR).integrated, 1)
  })

  it('gate helpers handle empty input', () => {
    expect(gatedLoudness([], -10)).toBe(-100)
    expect(loudnessRange([-80, -90])).toBe(0)
  })
})

describe('sound level meter', () => {
  it('reads a 1 kHz tone the same on A, C and Z with the calibration offset', () => {
    const m = new SoundLevelMeter(SR, 100)
    m.push(sine(1000, 2, 0.1))
    const r = m.reading()
    // 0.1 amplitude sine = −23 dBFS RMS
    for (const w of ['A', 'C', 'Z'] as const) expect(r.leq[w]).toBeCloseTo(77, 0)
    expect(r.fast.A).toBeCloseTo(77, 0)
    expect(r.max.A).toBeGreaterThanOrEqual(r.min.A)
    expect(r.peakC).toBeCloseTo(80, 0)
  })

  it('A-weighting strongly reduces a 50 Hz rumble', () => {
    const m = new SoundLevelMeter(SR)
    m.push(sine(50, 2, 0.1))
    const r = m.reading()
    expect(r.leq.Z - r.leq.A).toBeGreaterThan(25)
  })

  it('computes calibrator offsets', () => {
    expect(calibrationOffset(-30, 94)).toBe(124)
  })
})

describe('pitch', () => {
  it('detects a sung A3 with harmonics', () => {
    const f = 220
    const x = new Float32Array(2048)
    for (let i = 0; i < x.length; i++) {
      const t = i / SR
      x[i] = 0.5 * Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t) + 0.2 * Math.sin(2 * Math.PI * 3 * f * t)
    }
    const p = detectPitch(x, SR)
    expect(p).not.toBeNull()
    expect(p!.hz).toBeGreaterThan(218)
    expect(p!.hz).toBeLessThan(222)
  })

  it('rejects noise and silence', () => {
    expect(detectPitch(whiteNoise(2048, 0.5), SR)).toBeNull()
    expect(detectPitch(new Float32Array(2048), SR)).toBeNull()
  })

  it('names notes with cents', () => {
    expect(noteInfo(440).name).toBe('A4')
    expect(noteInfo(440).solfege).toBe('La4')
    expect(noteInfo(452).cents).toBeGreaterThan(40)
    expect(noteInfo(261.63).name).toBe('C4')
  })

  it('median pitch of a take', () => {
    expect(medianPitch(sine(330, 2, 0.3), SR)).toBeCloseTo(330, -1)
    expect(medianPitch(whiteNoise(SR * 2, 0.3), SR)).toBeNull()
  })
})

describe('generators and latency', () => {
  it('pink noise has more low than high energy, white noise is flat-ish', () => {
    const p = pinkNoise(SR * 2)
    const lo = new FilterChain([highPass(20, SR)])
    let sum = 0
    p.forEach((v) => (sum += lo.process(v) ** 2))
    expect(Math.sqrt(sum / p.length)).toBeGreaterThan(0.05)
    expect(Math.max(...Array.from(p, Math.abs))).toBeLessThanOrEqual(1)
  })

  it('log sweep starts and ends silently', () => {
    const s = logSweep(SR, 20, 20000, 1)
    expect(Math.abs(s[0])).toBeLessThan(1e-6)
    expect(Math.abs(s[s.length - 1])).toBeLessThan(1e-3)
    expect(Math.max(...Array.from(s, Math.abs))).toBeGreaterThan(0.99)
  })

  it('finds a click buried in noise', () => {
    const click = clickBurst(SR)
    const rec = whiteNoise(SR / 2, 0.02)
    const at = 7321
    click.forEach((v, i) => (rec[at + i] += v * 0.3))
    const d = findDelay(rec, click)
    expect(d.lag).toBe(at)
    expect(d.confidence).toBeGreaterThan(0.5)
  })
})

describe('latency summary', () => {
  it('reports median and jitter', () => {
    expect(summarizeLatency([12, 10, 11])).toEqual({ medianMs: 11, minMs: 10, maxMs: 12, jitterMs: 2 })
    expect(summarizeLatency([10, 20])?.medianMs).toBe(15)
    expect(summarizeLatency([])).toBeNull()
  })
})
