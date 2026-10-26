import { Compressor, DeEsser, Gate, Limiter, Saturator } from './dynamics'
import { NoiseSuppressor } from './noise'
import { bandStages, buildPreset, IDENTITY, nodeBiquad, type ProcessingChain } from './processor'

// Reference output of the app's processing chain for the plugin's parity test
// (plugin/src/dsp.rs must sound the same). Same order as ProcessorEngine: noise → gate → EQ →
// de-esser → comp 1 → comp 2 → saturation → limiter, 128-sample blocks like the AudioWorklet.

export const PARITY_RATE = 48000
export const PARITY_LENGTH = 24000
/** Every n-th output sample is stored */
export const PARITY_STRIDE = 4
export const PARITY_CASES: [string, string][] = [
  ['recorded', 'condenser'],
  ['stream', 'usb'],
  ['guitar-drive', 'di'],
  ['drum-kit', 'condenser']
]

/** Deterministic test signal: a voice-like tone with syllables, a bright partial and noise */
export function paritySignal(): Float32Array {
  const out = new Float32Array(PARITY_LENGTH)
  let seed = 12345
  for (let i = 0; i < PARITY_LENGTH; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const noise = (seed / 4294967296 - 0.5) * 0.02
    const t = i / PARITY_RATE
    const env = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 3 * t)), 2)
    out[i] = 0.4 * env * Math.sin(2 * Math.PI * 220 * t) + 0.15 * env * Math.sin(2 * Math.PI * 6500 * t) + noise
  }
  return out
}

export function parityProcess(chain: ProcessingChain, input: Float32Array): Float32Array {
  const sr = PARITY_RATE
  const noise = new NoiseSuppressor(sr, { ...chain.noise, resolution: 1024 })
  const gate = new Gate(sr, chain.gate)
  const deesser = new DeEsser(sr, chain.deesser)
  const comp1 = new Compressor(sr, chain.comp1)
  const comp2 = new Compressor(sr, chain.comp2)
  const sat = new Saturator(sr, chain.saturation)
  const limiter = new Limiter(sr, chain.limiter)
  // EQ: the same biquads Web Audio runs, as transposed direct form II
  const sections = chain.eq.bands.flatMap((b) => bandStages(b, chain.eq.on, sr)).filter((s) => s !== IDENTITY).map((s) => nodeBiquad(s, sr))
  const state = sections.map(() => [0, 0])
  const out = new Float32Array(input.length)
  for (let start = 0; start < input.length; start += 128) {
    const buf = input.slice(start, start + 128)
    noise.process(buf)
    gate.process(buf)
    sections.forEach((c, k) => {
      const z = state[k]
      for (let i = 0; i < buf.length; i++) {
        const x = buf[i]
        const y = c.b0 * x + z[0]
        z[0] = c.b1 * x - c.a1 * y + z[1]
        z[1] = c.b2 * x - c.a2 * y
        buf[i] = y
      }
    })
    deesser.process(buf)
    comp1.process(buf)
    comp2.process(buf)
    sat.process(buf)
    limiter.process(buf)
    out.set(buf, start)
  }
  return out
}

export function parityFixture(): { rate: number; length: number; stride: number; cases: { key: string; out: number[] }[] } {
  const input = paritySignal()
  return {
    rate: PARITY_RATE,
    length: PARITY_LENGTH,
    stride: PARITY_STRIDE,
    cases: PARITY_CASES.map(([u, m]) => {
      const out = parityProcess(buildPreset(u, m), input)
      const kept: number[] = []
      for (let i = 0; i < out.length; i += PARITY_STRIDE) kept.push(Number(out[i].toPrecision(6)))
      return { key: `${u}|${m}`, out: kept }
    })
  }
}
