// AudioWorklet side of the mic processor: thin wrappers that run the pure DSP from
// core/processor (dynamics.ts, noise.ts) and the loudness meter on mono blocks. Bundled by Vite
// (`?worker&url`), so it can import. Parameters arrive as objects on the port; each node
// reports what the UI draws ~30×/s.
import { Compressor, DeEsser, Gate, Limiter, Saturator, type CompParams, type DeEsserParams, type GateParams, type LimiterParams, type SaturationParams } from '../processor/dynamics'
import { NoiseSuppressor, type NoiseParams, type NoiseResolution } from '../processor/noise'
import { comp1Defaults, comp2Defaults, deesserDefaults, gateDefaults, limiterDefaults, noiseDefaults, saturationDefaults } from '../processor/processor'
import { LoudnessMeter } from '../studio/loudness'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: Record<string, unknown> })
}

abstract class MonoProcessor extends AudioWorkletProcessor {
  private sinceReport = 0
  protected reportEvery = sampleRate / 30

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options)
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data)
  }

  abstract onMessage(data: unknown): void
  abstract run(buf: Float32Array): void
  abstract report(): unknown

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const inp = inputs[0]?.[0]
    if (inp) out.set(inp)
    else out.fill(0)
    this.run(out)
    this.sinceReport += out.length
    if (this.sinceReport >= this.reportEvery) {
      this.sinceReport = 0
      const r = this.report()
      if (r) this.port.postMessage(r)
    }
    return true
  }
}

class NoiseProcessor extends MonoProcessor {
  private ns: NoiseSuppressor
  private frames = 0

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options)
    const resolution = (options?.processorOptions?.resolution as NoiseResolution) ?? 1024
    this.ns = new NoiseSuppressor(sampleRate, { ...noiseDefaults(), resolution })
    this.reportEvery = sampleRate / 15
  }

  onMessage(data: { type: 'params'; params: NoiseParams } | { type: 'learn'; seconds: number }): void {
    if (data.type === 'learn') this.ns.learn(data.seconds)
    else this.ns.set(data.params)
  }

  run(buf: Float32Array): void {
    this.ns.process(buf)
  }

  report(): unknown {
    const learned = this.ns.learnedProfile
    this.ns.learnedProfile = null
    this.frames++
    return {
      reduction: this.ns.reductionDb,
      learning: this.ns.learning,
      learned: learned ? Array.from(learned) : null,
      // Curves for the display, every other report (~7×/s)
      curves: this.frames % 2 === 0 ? { gains: Float32Array.from(this.ns.gains), noise: Float32Array.from(this.ns.noise), power: Float32Array.from(this.ns.power) } : null
    }
  }
}

class GateProcessor extends MonoProcessor {
  private gate = new Gate(sampleRate, { ...gateDefaults() })

  onMessage(p: GateParams): void {
    this.gate.set(p)
  }

  run(buf: Float32Array): void {
    this.gate.process(buf)
  }

  report(): unknown {
    return { open: this.gate.open, gainDb: this.gate.blockGainDb, level: this.gate.blockLevelDb }
  }
}

class DynamicsProcessor extends MonoProcessor {
  private deesser = new DeEsser(sampleRate, { ...deesserDefaults() })
  private comp1 = new Compressor(sampleRate, { ...comp1Defaults() })
  private comp2 = new Compressor(sampleRate, { ...comp2Defaults() })
  private sat = new Saturator(sampleRate, { ...saturationDefaults() })

  onMessage(p: { deesser: DeEsserParams; comp1: CompParams; comp2: CompParams; saturation: SaturationParams }): void {
    this.deesser.set(p.deesser)
    this.comp1.set(p.comp1)
    this.comp2.set(p.comp2)
    this.sat.set(p.saturation)
  }

  run(buf: Float32Array): void {
    this.deesser.process(buf)
    this.comp1.process(buf)
    this.comp2.process(buf)
    this.sat.process(buf)
  }

  report(): unknown {
    return { deess: this.deesser.blockGr, comp1: this.comp1.blockGr, comp2: this.comp2.blockGr, comp1In: this.comp1.blockLevelDb, comp2In: this.comp2.blockLevelDb }
  }
}

class LimiterProcessor extends MonoProcessor {
  private limiter = new Limiter(sampleRate, { ...limiterDefaults() })

  onMessage(p: LimiterParams): void {
    this.limiter.set(p)
  }

  run(buf: Float32Array): void {
    this.limiter.process(buf)
  }

  report(): unknown {
    return { gr: this.limiter.blockGr }
  }
}

/** Output loudness (EBU R128) and true peak; passes audio through untouched */
class MeterProcessor extends MonoProcessor {
  private meter = new LoudnessMeter(sampleRate)

  constructor(options?: { processorOptions?: Record<string, unknown> }) {
    super(options)
    this.reportEvery = sampleRate / 10
  }

  onMessage(data: { type: 'reset' }): void {
    if (data?.type === 'reset') this.meter.reset()
  }

  run(buf: Float32Array): void {
    this.meter.push(buf)
  }

  report(): unknown {
    const r = this.meter.reading()
    return { momentary: r.momentary, shortTerm: r.shortTerm, integrated: r.integrated, lra: r.lra, truePeak: r.truePeakDb }
  }
}

registerProcessor('vp-noise', NoiseProcessor)
registerProcessor('vp-gate', GateProcessor)
registerProcessor('vp-dynamics', DynamicsProcessor)
registerProcessor('vp-limiter', LimiterProcessor)
registerProcessor('vp-meter', MeterProcessor)
