import { describe, expect, it } from 'vitest'
import { measureRt60, rt60Verdict } from '../studio/acoustics'
import { rng } from '../studio/dsp'
import { addNotch, FeedbackDetector } from '../studio/feedback'
import { applyMidi, applyPreset, createStrip, defaultMixer, duckStep, eqResponse, learnMidi, mergeMixer, parseMidi, routingWarnings, STRIP_PRESETS } from './mixer'

const SR = 48000
const FFT = 8192
const BINS = FFT / 2

/** Noise-like spectrum around −90 dB with optional narrow peaks or a broad bump */
function spectrum(seed: number, peaks: { hz: number; db: number }[] = [], bump?: { hz: number; db: number }): Float32Array {
  const r = rng(seed)
  const s = new Float32Array(BINS)
  for (let i = 0; i < BINS; i++) s[i] = -90 + r() * 6
  for (const p of peaks) {
    const c = Math.round((p.hz * FFT) / SR)
    s[c] = p.db
    s[c - 1] = s[c + 1] = p.db - 6
  }
  if (bump) {
    for (let i = 0; i < BINS; i++) {
      const f = (i * SR) / FFT
      s[i] = Math.max(s[i], bump.db - Math.abs(Math.log2(f / bump.hz)) * 30)
    }
  }
  return s
}

describe('feedback detector', () => {
  it('reports a steady narrow peak once it has lasted long enough', () => {
    const d = new FeedbackDetector()
    let found: ReturnType<FeedbackDetector['push']> = []
    for (let t = 0; t <= 1000; t += 100) found = d.push(spectrum(t, [{ hz: 2500, db: -30 }]), SR, FFT, t)
    expect(found).toHaveLength(1)
    expect(found[0].hz).toBeGreaterThan(2490)
    expect(found[0].hz).toBeLessThan(2510)
    expect(found[0].sustainedMs).toBeGreaterThanOrEqual(600)
  })

  it('ignores a peak that moves (a voice) and a broad bump', () => {
    const d = new FeedbackDetector()
    let found: ReturnType<FeedbackDetector['push']> = []
    for (let t = 0; t <= 1500; t += 100) found = d.push(spectrum(t, [{ hz: 400 + t, db: -30 }], { hz: 1000, db: -40 }), SR, FFT, t)
    expect(found).toEqual([])
  })

  it('needs to be sustained', () => {
    const d = new FeedbackDetector()
    expect(d.push(spectrum(1, [{ hz: 3000, db: -30 }]), SR, FFT, 0)).toEqual([])
    expect(d.push(spectrum(2, [{ hz: 3000, db: -30 }]), SR, FFT, 300)).toEqual([])
  })

  it('notch list skips near-duplicates and keeps the newest six', () => {
    let list = addNotch([], 2500)
    list = addNotch(list, 2510)
    expect(list).toHaveLength(1)
    for (const f of [300, 600, 900, 1200, 1500, 1800]) list = addNotch(list, f)
    expect(list).toHaveLength(6)
    expect(list[0].hz).toBe(300)
  })

  it('notches show up in the strip response', () => {
    const s = { ...createStrip(0), notches: [{ hz: 2500, gainDb: -12, q: 30 }] }
    const [at, far] = eqResponse(s, [2500, 1000])
    expect(at).toBeLessThan(-11)
    expect(Math.abs(far)).toBeLessThan(0.1)
  })
})

describe('ducking', () => {
  const duck = { on: true, sourceId: 'v', thresholdDb: -40, amountDb: -15, attackMs: 40, releaseMs: 500 }

  it('drops quickly while the source talks and recovers slowly', () => {
    let g = 0
    for (let t = 0; t < 200; t += 20) g = duckStep(g, -20, duck, 20)
    expect(g).toBeLessThan(-14)
    let up = g
    for (let t = 0; t < 200; t += 20) up = duckStep(up, -80, duck, 20)
    expect(up).toBeLessThan(-5)
    for (let t = 0; t < 3000; t += 20) up = duckStep(up, -80, duck, 20)
    expect(up).toBe(0)
  })

  it('warns when the trigger strip is missing', () => {
    const cfg = defaultMixer()
    cfg.strips = [createStrip(0, { name: 'Música', duck: { ...duck, sourceId: 'nadie' } })]
    expect(routingWarnings(cfg).some((w) => /ducking/.test(w.message))).toBe(true)
  })
})

describe('MIDI', () => {
  it('parses CC and notes, velocity 0 = note-off', () => {
    expect(parseMidi([0xb2, 7, 100])).toEqual({ type: 'cc', channel: 3, number: 7, value: 100 })
    expect(parseMidi([0x90, 60, 0])?.type).toBe('noteoff')
    expect(parseMidi([0x90, 60, 90])?.type).toBe('noteon')
    expect(parseMidi([0xe0, 0, 64])).toBeNull()
    expect(parseMidi([0xb0])).toBeNull()
  })

  it('learned controls move faders and toggle mutes', () => {
    let cfg = defaultMixer()
    const id = cfg.strips[0].id
    cfg = learnMidi(cfg, 'cc:1:7', 'stripFader', id)
    cfg = learnMidi(cfg, 'note:1:36', 'stripMute', id)
    cfg = applyMidi(cfg, { type: 'cc', channel: 1, number: 7, value: 0 })
    expect(cfg.strips[0].faderDb).toBe(-60)
    cfg = applyMidi(cfg, { type: 'noteon', channel: 1, number: 36, value: 100 })
    expect(cfg.strips[0].mute).toBe(true)
    cfg = applyMidi(cfg, { type: 'noteoff', channel: 1, number: 36, value: 0 })
    expect(cfg.strips[0].mute).toBe(true)
    // Unmapped control: same object back
    expect(applyMidi(cfg, { type: 'cc', channel: 2, number: 1, value: 5 })).toBe(cfg)
  })

  it('re-learning a target replaces its old control', () => {
    let cfg = defaultMixer()
    const id = cfg.strips[0].id
    cfg = learnMidi(cfg, 'cc:1:7', 'stripFader', id)
    cfg = learnMidi(cfg, 'cc:1:8', 'stripFader', id)
    expect(cfg.midi).toEqual([{ key: 'cc:1:8', kind: 'stripFader', id }])
    expect(mergeMixer({ ...cfg }).midi).toHaveLength(1)
  })
})

describe('channel presets', () => {
  it('change processing but keep routing and levels', () => {
    const s = createStrip(0, { name: 'Ana', faderDb: -5, sends: ['A1', 'B1'] })
    const p = applyPreset(s, 'podcast')
    expect(p.comp.on).toBe(true)
    expect(p.hpf.on).toBe(true)
    expect(p.name).toBe('Ana')
    expect(p.faderDb).toBe(-5)
    expect(p.sends).toEqual(['A1', 'B1'])
    expect(applyPreset(s, 'nope')).toBe(s)
    expect(new Set(STRIP_PRESETS.map((x) => x.id)).size).toBe(STRIP_PRESETS.length)
  })

  it('applying a preset twice does not share objects', () => {
    const a = applyPreset(createStrip(0), 'speech')
    const b = applyPreset(createStrip(1), 'speech')
    a.eq.bands[0].gainDb = 9
    expect(b.eq.bands[0].gainDb).not.toBe(9)
  })
})

describe('RT60', () => {
  /** Exponentially decaying noise with a known reverberation time, then a noise floor */
  function decay(rt: number, seconds = 3): Float32Array {
    const r = rng(5)
    const pcm = new Float32Array(SR * seconds)
    const k = 6.908 / rt // amplitude decays 60 dB over rt
    for (let i = 0; i < pcm.length; i++) {
      const t = i / SR
      pcm[i] = (r() * 2 - 1) * (Math.exp(-k * t) + 1e-4)
    }
    return pcm
  }

  it('recovers the reverberation time of a synthetic decay', () => {
    for (const rt of [0.4, 1.2]) {
      const m = measureRt60(decay(rt), SR)
      expect(m.t20).not.toBeNull()
      expect(Math.abs(m.t20! - rt) / rt).toBeLessThan(0.1)
      expect(m.dynamicRangeDb).toBeGreaterThan(45)
      expect(m.curve[0]).toBe(0)
    }
  })

  it('refuses a decay that barely rises above the noise', () => {
    const r = rng(9)
    const flat = new Float32Array(SR * 2).map(() => (r() * 2 - 1) * 0.1)
    expect(measureRt60(flat, SR).t20).toBeNull()
  })

  it('explains the result', () => {
    expect(rt60Verdict(0.2)).toMatch(/seca/)
    expect(rt60Verdict(2.5)).toMatch(/iglesia/)
  })
})
