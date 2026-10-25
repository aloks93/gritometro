// AudioWorklet side of the mic processor: thin wrappers that run the pure DSP from
// core/processor/dynamics.ts on mono blocks. Bundled by Vite (`?worker&url`), so it can import.
// Parameters arrive as whole objects on the port; each node reports its gain reduction ~30×/s.
import { Compressor, DeEsser, Gate, Limiter, type CompParams, type DeEsserParams, type GateParams, type LimiterParams } from '../processor/dynamics'
import { comp1Defaults, comp2Defaults, deesserDefaults, gateDefaults, limiterDefaults } from '../processor/processor'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

abstract class MonoProcessor extends AudioWorkletProcessor {
  private sinceReport = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => this.onParams(e.data)
  }

  abstract onParams(data: unknown): void
  abstract run(buf: Float32Array): void
  abstract report(): Record<string, number | boolean>

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out) return true
    const inp = inputs[0]?.[0]
    if (inp) out.set(inp)
    else out.fill(0)
    this.run(out)
    this.sinceReport += out.length
    if (this.sinceReport >= sampleRate / 30) {
      this.sinceReport = 0
      this.port.postMessage(this.report())
    }
    return true
  }
}

class GateProcessor extends MonoProcessor {
  private gate = new Gate(sampleRate, { ...gateDefaults() })

  onParams(p: GateParams): void {
    this.gate.set(p)
  }

  run(buf: Float32Array): void {
    this.gate.process(buf)
  }

  report(): Record<string, number | boolean> {
    return { open: this.gate.open, gainDb: this.gate.blockGainDb }
  }
}

class DynamicsProcessor extends MonoProcessor {
  private deesser = new DeEsser(sampleRate, { ...deesserDefaults() })
  private comp1 = new Compressor(sampleRate, { ...comp1Defaults() })
  private comp2 = new Compressor(sampleRate, { ...comp2Defaults() })

  onParams(p: { deesser: DeEsserParams; comp1: CompParams; comp2: CompParams }): void {
    this.deesser.set(p.deesser)
    this.comp1.set(p.comp1)
    this.comp2.set(p.comp2)
  }

  run(buf: Float32Array): void {
    this.deesser.process(buf)
    this.comp1.process(buf)
    this.comp2.process(buf)
  }

  report(): Record<string, number | boolean> {
    return { deess: this.deesser.blockGr, comp1: this.comp1.blockGr, comp2: this.comp2.blockGr }
  }
}

class LimiterProcessor extends MonoProcessor {
  private limiter = new Limiter(sampleRate, { ...limiterDefaults() })

  onParams(p: LimiterParams): void {
    this.limiter.set(p)
  }

  run(buf: Float32Array): void {
    this.limiter.process(buf)
  }

  report(): Record<string, number | boolean> {
    return { gr: this.limiter.blockGr }
  }
}

registerProcessor('vp-gate', GateProcessor)
registerProcessor('vp-dynamics', DynamicsProcessor)
registerProcessor('vp-limiter', LimiterProcessor)
