import { logSweep, pinkNoise, whiteNoise } from '../../core/studio/dsp'

// Test-signal generator on its own output context, so it survives microphone restarts.

export type SignalKind = 'sine' | 'square' | 'pink' | 'white' | 'sweep'

export interface SignalOptions {
  kind: SignalKind
  /** Tones only */
  freqHz: number
  /** Peak level for tones; noise is scaled to the same RMS as a sine at this level */
  levelDb: number
  /** Sweep length in seconds */
  sweepSeconds: number
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

class Generator {
  private ctx: SinkContext | null = null
  private src: AudioScheduledSourceNode | null = null
  private osc: OscillatorNode | null = null
  private gain: GainNode | null = null
  private sinkId: string | null = null
  private buffers = new Map<string, AudioBuffer>()
  running: SignalOptions | null = null

  private context(): SinkContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' }) as SinkContext
      if (this.sinkId) this.ctx.setSinkId?.(this.sinkId).catch(() => undefined)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  setOutput(id: string | null): void {
    this.sinkId = id
    this.ctx?.setSinkId?.(id ?? '').catch(() => undefined)
  }

  private buffer(kind: 'pink' | 'white' | 'sweep', sweepSeconds: number): AudioBuffer {
    const c = this.context()
    const key = `${kind}-${sweepSeconds}-${c.sampleRate}`
    const cached = this.buffers.get(key)
    if (cached) return cached
    const sr = c.sampleRate
    let data: Float32Array
    if (kind === 'sweep') {
      const sweep = logSweep(sr, 20, 20000, sweepSeconds)
      // Half a second of silence between sweeps
      data = new Float32Array(sweep.length + Math.round(sr * 0.5))
      data.set(sweep)
    } else {
      data = kind === 'pink' ? pinkNoise(sr * 10, 1) : whiteNoise(sr * 10, 1)
      // Scale to the RMS of a full-scale sine (1/√2) so the level control means the same thing
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const k = Math.SQRT1_2 / Math.sqrt(sum / data.length)
      for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i] * k))
    }
    const buf = c.createBuffer(1, data.length, sr)
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
    this.buffers.set(key, buf)
    return buf
  }

  start(o: SignalOptions): void {
    this.stop(0)
    const c = this.context()
    const g = c.createGain()
    g.gain.value = 0
    g.gain.setTargetAtTime(Math.pow(10, o.levelDb / 20), c.currentTime, 0.015)
    g.connect(c.destination)
    let src: AudioScheduledSourceNode
    if (o.kind === 'sine' || o.kind === 'square') {
      const osc = c.createOscillator()
      osc.type = o.kind
      osc.frequency.value = o.freqHz
      this.osc = osc
      src = osc
    } else {
      const b = c.createBufferSource()
      b.buffer = this.buffer(o.kind, o.sweepSeconds)
      b.loop = true
      src = b
    }
    src.connect(g)
    src.start()
    this.src = src
    this.gain = g
    this.running = o
  }

  /** Live updates without restarting (no clicks) */
  update(o: SignalOptions): void {
    if (!this.running || !this.ctx || !this.gain) return
    const kindChanged = o.kind !== this.running.kind || (o.kind === 'sweep' && o.sweepSeconds !== this.running.sweepSeconds)
    if (kindChanged) return this.start(o)
    const t = this.ctx.currentTime
    this.gain.gain.setTargetAtTime(Math.pow(10, o.levelDb / 20), t, 0.015)
    this.osc?.frequency.setTargetAtTime(o.freqHz, t, 0.01)
    this.running = o
  }

  stop(fade = 0.03): void {
    const src = this.src
    const g = this.gain
    const c = this.ctx
    this.src = null
    this.osc = null
    this.gain = null
    this.running = null
    if (!src || !g || !c) return
    g.gain.setTargetAtTime(0, c.currentTime, fade / 3 || 0.001)
    setTimeout(() => {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
      g.disconnect()
    }, fade * 1000 + 30)
  }
}

export const generator = new Generator()
