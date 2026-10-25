import { describe, expect, it } from 'vitest'
import type { LevelReading } from '../audio/LevelAnalyzer'
import {
  aWeightingDb,
  aWeightingOffset,
  BAND_CENTERS,
  bandCurve,
  bandShares,
  curveDifference,
  decodeWav,
  detectHum,
  dominantFrequency,
  encodeWav,
  envelope,
  matchGain,
  noteName,
  pcmRms,
  pcmStats,
  smoothCurve,
  spectralCentroid,
  summarizeTake,
  technicalScore
} from './analysis'

const SR = 48000
const FFT = 8192
const BINS = FFT / 2

/** Flat power spectrum with an optional boost region */
function spectrum(boost?: { from: number; to: number; gain: number }): Float32Array {
  const p = new Float32Array(BINS).fill(1e-6)
  if (boost) {
    for (let i = 0; i < BINS; i++) {
      const f = (i * SR) / FFT
      if (f >= boost.from && f < boost.to) p[i] *= boost.gain
    }
  }
  return p
}

function frames(levels: number[], clipped = false): LevelReading[] {
  return levels.map((db, i) => ({ t: i * 16, rmsDb: db, peakDb: db + 10, smoothedDb: db, clipped }))
}

describe('spectral helpers', () => {
  it('centroid rises when highs are boosted', () => {
    const dark = spectralCentroid(spectrum({ from: 20, to: 500, gain: 1e5 }), SR, FFT)
    const bright = spectralCentroid(spectrum({ from: 5000, to: 12000, gain: 1e5 }), SR, FFT)
    expect(dark).toBeLessThan(1000)
    expect(bright).toBeGreaterThan(7000)
  })

  it('band shares sum to 1 and detect boomy mics', () => {
    const b = bandShares(spectrum({ from: 20, to: 250, gain: 1000 }), SR, FFT)
    expect(b.low + b.mid + b.high).toBeCloseTo(1)
    expect(b.low).toBeGreaterThan(0.9)
  })

  it('curve has one value per band and shows a boost', () => {
    const c = bandCurve(spectrum({ from: 900, to: 1120, gain: 100 }), SR, FFT)
    expect(c).toHaveLength(BAND_CENTERS.length)
    const i1k = BAND_CENTERS.indexOf(1000)
    expect(c[i1k]).toBe(Math.max(...c))
    expect(c[i1k] - c[0]).toBeGreaterThan(15)
  })
})

describe('summarizeTake + technicalScore', () => {
  const flat = spectrum({ from: 250, to: 4000, gain: 20 })

  it('computes SNR from the voiced frames', () => {
    const m = summarizeTake({ frames: frames([...Array(50).fill(-80), ...Array(100).fill(-20)]), noiseFloorDb: -70, power: flat, sampleRate: SR, fftSize: FFT })
    expect(m.levelDb).toBeCloseTo(-20)
    expect(m.snrDb).toBeCloseTo(50)
    expect(m.crestDb).toBeCloseTo(10)
  })

  it('a quiet noisy mic scores below a clean one; clipping costs points', () => {
    const clean = summarizeTake({ frames: frames(Array(100).fill(-20)), noiseFloorDb: -70, power: flat, sampleRate: SR, fftSize: FFT })
    const noisy = summarizeTake({ frames: frames(Array(100).fill(-38)), noiseFloorDb: -50, power: flat, sampleRate: SR, fftSize: FFT })
    const clipped = summarizeTake({ frames: frames(Array(100).fill(-20), true), noiseFloorDb: -70, power: flat, sampleRate: SR, fftSize: FFT })
    expect(technicalScore(clean).total).toBeGreaterThan(technicalScore(noisy).total)
    expect(technicalScore(clipped).total).toBeLessThan(technicalScore(clean).total)
    expect(technicalScore(noisy).notes.length).toBeGreaterThan(0)
  })
})

describe('playback + export helpers', () => {
  it('loudness matching gain', () => {
    const pcm = new Float32Array(1000).fill(0.1)
    expect(pcmRms(pcm)).toBeCloseTo(0.1)
    expect(matchGain(0.1, 0.2)).toBeCloseTo(2)
    expect(matchGain(0.001, 0.2)).toBe(8)
  })

  it('writes a valid 16-bit mono WAV header', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), SR)
    const v = new DataView(wav)
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(SR)
    expect(v.getUint32(40, true)).toBe(8)
    expect(v.getInt16(46, true)).toBe(0x7fff)
    expect(v.getInt16(48, true)).toBe(-0x8000)
  })
})

describe('noise analysis', () => {
  it('A-weighting matches the standard curve', () => {
    expect(aWeightingDb(1000)).toBeCloseTo(0, 0)
    expect(aWeightingDb(100)).toBeCloseTo(-19.1, 0)
    expect(aWeightingDb(10000)).toBeCloseTo(-2.5, 0)
  })

  it('low rumble is discounted by A-weighting, mid noise is not', () => {
    expect(aWeightingOffset(spectrum({ from: 20, to: 120, gain: 1e6 }), SR, FFT)).toBeLessThan(-15)
    expect(Math.abs(aWeightingOffset(spectrum({ from: 900, to: 1200, gain: 1e6 }), SR, FFT))).toBeLessThan(2)
  })

  it('finds 50 Hz mains hum and ignores flat noise', () => {
    const p = spectrum()
    for (const f of [50, 100, 150, 200]) p[Math.round((f * FFT) / SR)] = 1e-3
    expect(detectHum(p, SR, FFT)?.hz).toBe(50)
    expect(detectHum(spectrum(), SR, FFT)).toBeNull()
  })

  it('tells 60 Hz hum apart from 50 Hz', () => {
    const p = spectrum()
    for (const f of [60, 120, 180]) p[Math.round((f * FFT) / SR)] = 1e-3
    expect(detectHum(p, SR, FFT)?.hz).toBe(60)
  })

  it('summarizeTake adds noise, DC and envelope details when given the data', () => {
    const pcm = new Float32Array(4800).fill(0.05)
    pcm[100] = 1
    const m = summarizeTake({ frames: frames(Array(100).fill(-20)), noiseFloorDb: -70, power: spectrum(), sampleRate: SR, fftSize: FFT, noisePower: spectrum(), pcm })
    expect(m.noiseADb).toBeDefined()
    expect(m.hum).toBeNull()
    expect(m.dcOffset).toBeCloseTo(0.05, 2)
    expect(m.clippedSamples).toBe(1)
    expect(m.envelope).toHaveLength(160)
    expect(technicalScore(m).notes.some((n) => n.includes('DC'))).toBe(true)
  })
})

describe('live helpers', () => {
  it('finds the dominant frequency between bins', () => {
    const db = new Float32Array(BINS).fill(-100)
    const bin = 1000 / (SR / FFT) // 170.67
    db[170] = -20
    db[171] = -18
    db[172] = -30
    const d = dominantFrequency(db, SR, FFT)!
    expect(Math.abs(d.hz - 1000)).toBeLessThan(6)
    expect(bin).toBeGreaterThan(170)
    expect(dominantFrequency(new Float32Array(BINS).fill(-120), SR, FFT)).toBeNull()
  })

  it('names notes', () => {
    expect(noteName(440)).toBe('A4')
    expect(noteName(261.6)).toBe('C4')
  })
})

describe('pcm helpers', () => {
  it('pcmStats measures DC, clipping and sample peak', () => {
    const s = pcmStats(new Float32Array([0.5, -0.5, 1, -1]))
    expect(s.dcOffset).toBe(0)
    expect(s.clippedSamples).toBe(2)
    expect(s.peakDb).toBe(0)
  })

  it('envelope keeps the peak of each slice', () => {
    const e = envelope(new Float32Array([0.1, -0.9, 0.2, 0.3]), 2)
    expect(e).toEqual([0.9, 0.3])
  })
})
describe('extended take analysis', () => {
  it('adds loudness, true peak and pitch when PCM is available', () => {
    const pcm = new Float32Array(SR * 3)
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / SR)
    const m = summarizeTake({ frames: frames(Array(180).fill(-35)), noiseFloorDb: -70, power: spectrum(), sampleRate: SR, fftSize: FFT, pcm })
    expect(m.lufs).toBeGreaterThan(-25)
    expect(m.lufs).toBeLessThan(-21)
    expect(m.truePeakDb).toBeCloseTo(-20, 0)
    expect(m.pitchHz).toBeCloseTo(220, -1)
  })

  it('curve difference and smoothing', () => {
    expect(curveDifference([1, 2, 3], [1, 1, 1])).toEqual([0, 1, 2])
    expect(smoothCurve([0, 3, 0], 1)).toEqual([1.5, 1, 1.5])
  })

  it('round-trips 16/24-bit and float WAV', () => {
    const x = new Float32Array([0, 0.5, -0.5, 0.25, -1])
    for (const f of [16, 24, 'float'] as const) {
      const back = decodeWav(encodeWav(x, SR, f))!
      expect(back.sampleRate).toBe(SR)
      expect(back.pcm.length).toBe(x.length)
      back.pcm.forEach((v, i) => expect(v).toBeCloseTo(x[i], 3))
    }
    expect(decodeWav(new ArrayBuffer(10))).toBeNull()
  })
})
