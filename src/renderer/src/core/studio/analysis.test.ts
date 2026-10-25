import { describe, expect, it } from 'vitest'
import type { LevelReading } from '../audio/LevelAnalyzer'
import {
  BAND_CENTERS,
  bandCurve,
  bandShares,
  encodeWav,
  matchGain,
  pcmRms,
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
