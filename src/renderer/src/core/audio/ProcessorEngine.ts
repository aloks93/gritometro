import type { ProcessorConfig } from '../processor/processor'
import { bandStages, MAX_BANDS, STAGES_PER_BAND } from '../processor/processor'
import { lookaheadSamples } from '../processor/dynamics'
import { noiseLatency } from '../processor/noise'
import { dbToGain } from '../mixer/mixer'
// Bundled as its own script so the worklet can import the shared DSP
import workletUrl from './processor.worklet.ts?worker&url'

// Web Audio graph of the mic processor. One mic channel in, processed mono out to a
// device (VoiceMeeter Input, a virtual cable…) plus an optional headphone monitor.
//
// mic → channel → input gain → phase ─┬→ noise reduction → gate → [EQ] → de-esser/comp1/comp2/saturation → [EQ] → limiter → wet ─┐
//                                      └→ delay (= noise frame + look-ahead) → dry (bypass) ──────────────────────────────────────┴→ output gain
// output gain → mute → output device · → monitor level → headphones · → loudness meter · → stream (studio analyzers)

export type ProcessorStatus = 'off' | 'starting' | 'on' | 'error'

export interface ProcessorState {
  status: ProcessorStatus
  error?: string
  sampleRate?: number
  /** Channels reported by the input device */
  channels?: number
  inputLabel?: string
  /** Device + processing latency estimate, ms */
  latencyMs?: number
  /** Bumped on every (re)build so stream consumers can re-attach */
  generation: number
}

export interface ProcessorLevels {
  inPeak: number
  inRms: number
  outPeak: number
  outRms: number
  gateOpen: boolean
  gateDb: number
  deessGr: number
  comp1Gr: number
  comp2Gr: number
  limGr: number
  /** Noise reduction applied right now, dB (≤ 0) */
  noiseGr: number
  noiseLearning: boolean
  /** Detector levels, for the live dots on the transfer curves */
  gateLevel: number
  comp1In: number
  comp2In: number
}

export interface ProcessorLoudness {
  momentary: number
  shortTerm: number
  integrated: number
  lra: number
  truePeak: number
}

/** Last frame of the noise suppressor, per FFT bin */
export interface NoiseCurves {
  gains: Float32Array
  noise: Float32Array
  power: Float32Array
  /** FFT size the bins belong to */
  size: number
  sampleRate: number
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; outputLatency?: number }
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

interface Graph {
  ctx: SinkContext
  stream: MediaStream
  inGain: GainNode
  phase: GainNode
  inMeter: AnalyserNode
  /** Raw input for the instrument tuner (long window: a low B is ≈ 31 Hz) */
  tuner: AnalyserNode
  noise: AudioWorkletNode
  noiseSize: number
  meter: AudioWorkletNode
  gate: AudioWorkletNode
  eq: BiquadFilterNode[]
  dynamics: AudioWorkletNode
  limiter: AudioWorkletNode
  wet: GainNode
  dry: GainNode
  outGain: GainNode
  outMeter: AnalyserNode
  mute: GainNode
  inSpectrum: AnalyserNode
  outSpectrum: AnalyserNode
  outStream: MediaStreamAudioDestinationNode
  monitor: { level: GainNode; audio: SinkAudio } | null
}

const TC = 0.015
export const PROCESSOR_FFT = 8192
/** Samples the tuner reads per frame */
export const TUNER_SIZE = 4096

/** Inputs whose change needs the graph rebuilt (everything else is applied live) */
export function processorStructureKey(cfg: ProcessorConfig): string {
  return JSON.stringify([cfg.sampleRate, cfg.input.deviceId, cfg.input.channel, cfg.eqPosition, cfg.monitor.on, cfg.noise.resolution])
}

export class ProcessorEngine {
  private g: Graph | null = null
  private key = ''
  private latest: ProcessorConfig | null = null
  private seq = 0
  private listeners = new Set<(s: ProcessorState) => void>()
  private _state: ProcessorState = { status: 'off', generation: 0 }
  private buf = new Float32Array(2048)
  private reports = emptyReports()
  private loud: ProcessorLoudness | null = null
  private curves: NoiseCurves | null = null
  private profileListeners = new Set<(profile: number[]) => void>()

  get state(): ProcessorState {
    return this._state
  }

  get running(): boolean {
    return this._state.status === 'on'
  }

  onState(l: (s: ProcessorState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setState(patch: Partial<ProcessorState>): void {
    this._state = { ...this._state, ...patch }
    this.listeners.forEach((l) => l(this._state))
  }

  async start(cfg: ProcessorConfig): Promise<void> {
    this.latest = cfg
    this.teardown()
    const seq = ++this.seq
    this.setState({ status: 'starting', error: undefined })
    let stream: MediaStream | null = null
    let ctx: SinkContext | null = null
    try {
      ctx = new AudioContext({ latencyHint: 'interactive', ...(cfg.sampleRate ? { sampleRate: cfg.sampleRate } : {}) }) as SinkContext
      await ctx.audioWorklet.addModule(workletUrl)
      const constraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 32 } }
      if (cfg.input.deviceId && cfg.input.deviceId !== 'default') constraints.deviceId = { exact: cfg.input.deviceId }
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
      if (seq !== this.seq) throw new Error('superseded')
      const g = this.build(ctx, stream, cfg)
      this.g = g
      this.key = processorStructureKey(cfg)
      const track = stream.getAudioTracks()[0]
      track.onended = () => {
        if (this.g === g) {
          this.teardown()
          this.setState({ status: 'error', error: 'El micrófono se desconectó.' })
        }
      }
      const newest = this.latest && processorStructureKey(this.latest) === this.key ? this.latest : cfg
      this.applyParams(newest)
      if (ctx.state === 'suspended') await ctx.resume()
      const settings = track.getSettings() as MediaTrackSettings & { latency?: number }
      const latencyMs = ((settings.latency ?? 0) + ctx.baseLatency + (ctx.outputLatency ?? 0)) * 1000 + ((lookaheadSamples(ctx.sampleRate) + g.noiseSize) / ctx.sampleRate) * 1000
      this.setState({
        status: 'on',
        sampleRate: ctx.sampleRate,
        channels: Math.max(1, settings.channelCount ?? 1),
        inputLabel: track.label,
        latencyMs: Math.round(latencyMs * 10) / 10,
        generation: this._state.generation + 1
      })
      if (this.latest && processorStructureKey(this.latest) !== this.key) void this.start(this.latest)
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop())
      if (this.g?.ctx !== ctx) ctx?.close().catch(() => undefined)
      if (seq !== this.seq) return
      this.teardown()
      this.setState({ status: 'error', error: describe(err) })
    }
  }

  stop(): void {
    this.seq++
    this.teardown()
    this.setState({ status: 'off', error: undefined })
  }

  /** Parameters go live; structural changes (device, channel, EQ position, monitor) rebuild */
  apply(cfg: ProcessorConfig): void {
    this.latest = cfg
    if (this._state.status === 'off' || this._state.status === 'error') return
    if (this._state.status === 'starting' && !this.key) return
    if (processorStructureKey(cfg) !== this.key) {
      void this.start(cfg)
      return
    }
    this.applyParams(cfg)
  }

  private teardown(): void {
    const g = this.g
    this.g = null
    this.key = ''
    if (!g) return
    if (g.monitor) {
      g.monitor.audio.pause()
      g.monitor.audio.srcObject = null
    }
    g.stream.getTracks().forEach((t) => t.stop())
    g.ctx.close().catch(() => undefined)
  }

  private build(ctx: SinkContext, stream: MediaStream, cfg: ProcessorConfig): Graph {
    const src = ctx.createMediaStreamSource(stream)
    const channels = Math.max(1, stream.getAudioTracks()[0].getSettings().channelCount ?? src.channelCount ?? 1)
    const mono = (n: AudioNode): AudioNode => {
      n.channelCount = 1
      n.channelCountMode = 'explicit'
      n.channelInterpretation = 'speakers'
      return n
    }
    const inGain = mono(ctx.createGain()) as GainNode
    if (cfg.input.channel >= 0 && channels > 1) {
      src.channelCount = channels
      src.channelCountMode = 'explicit'
      src.channelInterpretation = 'discrete'
      const split = ctx.createChannelSplitter(channels)
      src.connect(split)
      split.connect(inGain, Math.min(cfg.input.channel, channels - 1))
    } else {
      // Mono device, or "mix": the explicit 1-channel input down-mixes every channel
      src.connect(inGain)
    }
    const phase = mono(ctx.createGain()) as GainNode
    const inMeter = analyser(ctx, 2048)
    const tuner = analyser(ctx, TUNER_SIZE)
    const worklet = (name: string): AudioWorkletNode =>
      new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' })
    const noiseSize = noiseLatency(cfg.noise.resolution)
    const noise = new AudioWorkletNode(ctx, 'vp-noise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { resolution: cfg.noise.resolution }
    })
    const meter = worklet('vp-meter')
    const gate = worklet('vp-gate')
    const dynamics = worklet('vp-dynamics')
    const limiter = worklet('vp-limiter')
    // Every band has its stages in the graph all the time: editing never rebuilds
    const eq = Array.from({ length: MAX_BANDS * STAGES_PER_BAND }, () => mono(ctx.createBiquadFilter()) as BiquadFilterNode)
    const wet = mono(ctx.createGain()) as GainNode
    const dryDelay = ctx.createDelay(0.05)
    // The dry path waits exactly as long as the processed one, so A/B never shifts in time
    dryDelay.delayTime.value = (lookaheadSamples(ctx.sampleRate) + noiseSize) / ctx.sampleRate
    const dry = mono(ctx.createGain()) as GainNode
    const outGain = mono(ctx.createGain()) as GainNode
    const outMeter = analyser(ctx, 2048)
    const mute = ctx.createGain()
    const inSpectrum = analyser(ctx, PROCESSOR_FFT, 0.6)
    const outSpectrum = analyser(ctx, PROCESSOR_FFT, 0.6)
    const outStream = ctx.createMediaStreamDestination()

    inGain.connect(phase)
    phase.connect(inMeter)
    phase.connect(tuner)
    const dynChain = cfg.eqPosition === 'post' ? [dynamics, ...eq] : [...eq, dynamics]
    chain([phase, noise, gate, ...dynChain, limiter, wet, outGain])
    gate.connect(inSpectrum)
    chain([phase, dryDelay, dry, outGain])
    outGain.connect(outMeter)
    outGain.connect(outSpectrum)
    outGain.connect(outStream)
    // The meter must be pulled by the graph: route it into a silent gain
    const silent = ctx.createGain()
    silent.gain.value = 0
    outGain.connect(meter).connect(silent).connect(ctx.destination)
    // A mono node into the stereo destination is up-mixed to both sides
    outGain.connect(mute).connect(ctx.destination)

    let monitor: Graph['monitor'] = null
    if (cfg.monitor.on) {
      const level = ctx.createGain()
      const dest = ctx.createMediaStreamDestination()
      outGain.connect(level).connect(dest)
      const audio = new Audio() as SinkAudio
      audio.srcObject = dest.stream
      void audio.play().catch(() => undefined)
      monitor = { level, audio }
    }

    this.reports = emptyReports()
    this.loud = null
    this.curves = null
    gate.port.onmessage = (e: MessageEvent<{ open: boolean; gainDb: number; level: number }>) => {
      this.reports.gateOpen = e.data.open
      this.reports.gateDb = e.data.gainDb
      this.reports.gateLevel = e.data.level
    }
    dynamics.port.onmessage = (e: MessageEvent<{ deess: number; comp1: number; comp2: number; comp1In: number; comp2In: number }>) => {
      this.reports.deess = e.data.deess
      this.reports.comp1 = e.data.comp1
      this.reports.comp2 = e.data.comp2
      this.reports.comp1In = e.data.comp1In
      this.reports.comp2In = e.data.comp2In
    }
    noise.port.onmessage = (e: MessageEvent<{ reduction: number; learning: boolean; learned: number[] | null; curves: Omit<NoiseCurves, 'size' | 'sampleRate'> | null }>) => {
      this.reports.noise = e.data.reduction
      this.reports.noiseLearning = e.data.learning
      if (e.data.curves) this.curves = { ...e.data.curves, size: noiseSize, sampleRate: ctx.sampleRate }
      const learned = e.data.learned
      if (learned) this.profileListeners.forEach((l) => l(learned))
    }
    meter.port.onmessage = (e: MessageEvent<ProcessorLoudness>) => {
      this.loud = e.data
    }
    limiter.port.onmessage = (e: MessageEvent<{ gr: number }>) => {
      this.reports.lim = e.data.gr
    }
    return { ctx, stream, inGain, phase, inMeter, tuner, noise, noiseSize, meter, gate, eq, dynamics, limiter, wet, dry, outGain, outMeter, mute, inSpectrum, outSpectrum, outStream, monitor }
  }

  private applyParams(cfg: ProcessorConfig): void {
    const g = this.g
    if (!g) return
    const t = g.ctx.currentTime
    const set = (p: AudioParam, v: number): void => {
      p.setTargetAtTime(v, t, TC)
    }
    set(g.inGain.gain, Math.pow(10, cfg.inputGainDb / 20))
    set(g.phase.gain, cfg.phaseInvert ? -1 : 1)
    g.noise.port.postMessage({ type: 'params', params: cfg.noise })
    g.gate.port.postMessage(cfg.gate)
    g.dynamics.port.postMessage({ deesser: cfg.deesser, comp1: cfg.comp1, comp2: cfg.comp2, saturation: cfg.saturation })
    g.limiter.port.postMessage(cfg.limiter)
    for (let b = 0; b < MAX_BANDS; b++) {
      const band = cfg.eq.bands[b]
      const stages = band ? bandStages(band, cfg.eq.on, g.ctx.sampleRate) : bandStages({ on: false, type: 'peaking', freq: 1000, gainDb: 0, q: 1, slope: 12 }, false, g.ctx.sampleRate)
      stages.forEach((s, k) => {
        const node = g.eq[b * STAGES_PER_BAND + k]
        if (node.type !== s.type) node.type = s.type
        set(node.frequency, s.frequency)
        set(node.Q, s.Q)
        set(node.gain, s.gain)
      })
    }
    set(g.wet.gain, cfg.bypass ? 0 : 1)
    set(g.dry.gain, cfg.bypass ? 1 : 0)
    set(g.outGain.gain, Math.pow(10, cfg.outputGainDb / 20))
    set(g.mute.gain, cfg.output.mute ? 0 : 1)
    g.ctx.setSinkId?.(cfg.output.deviceId ?? '').catch(() => undefined)
    if (g.monitor) {
      set(g.monitor.level.gain, dbToGain(cfg.monitor.levelDb))
      g.monitor.audio.setSinkId?.(cfg.monitor.deviceId ?? '').catch(() => undefined)
    }
  }

  // ---- Metering

  private level(an: AnalyserNode): { peak: number; rms: number } {
    if (this.buf.length !== an.fftSize) this.buf = new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(this.buf)
    let peak = 0
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i]
      const a = Math.abs(v)
      if (a > peak) peak = a
      sum += v * v
    }
    return { peak: toDb(peak), rms: toDb(Math.sqrt(sum / this.buf.length)) }
  }

  levels(): ProcessorLevels | null {
    const g = this.g
    if (!g) return null
    const i = this.level(g.inMeter)
    const o = this.level(g.outMeter)
    const r = this.reports
    return {
      inPeak: i.peak,
      inRms: i.rms,
      outPeak: o.peak,
      outRms: o.rms,
      gateOpen: r.gateOpen,
      gateDb: r.gateDb,
      deessGr: r.deess,
      comp1Gr: r.comp1,
      comp2Gr: r.comp2,
      limGr: r.lim,
      noiseGr: r.noise,
      noiseLearning: r.noiseLearning,
      gateLevel: r.gateLevel,
      comp1In: r.comp1In,
      comp2In: r.comp2In
    }
  }

  /** Output loudness (LUFS) and true peak, null until the first reading */
  loudness(): ProcessorLoudness | null {
    return this.g ? this.loud : null
  }

  resetLoudness(): void {
    this.g?.meter.port.postMessage({ type: 'reset' })
  }

  /** Last noise-suppressor frame (gains, noise estimate, input power per bin) */
  noiseCurves(): NoiseCurves | null {
    return this.g ? this.curves : null
  }

  /** Captures the noise profile for `seconds`; the result arrives through onNoiseProfile */
  learnNoise(seconds: number): boolean {
    if (!this.g) return false
    this.g.noise.port.postMessage({ type: 'learn', seconds })
    this.reports.noiseLearning = true
    return true
  }

  onNoiseProfile(l: (profile: number[]) => void): () => void {
    this.profileListeners.add(l)
    return () => this.profileListeners.delete(l)
  }

  /** Spectrum (dB per bin, PROCESSOR_FFT / 2 bins) entering the EQ or leaving the processor */
  spectrum(which: 'in' | 'out', out: Float32Array<ArrayBuffer>): boolean {
    const g = this.g
    const an = which === 'in' ? g?.inSpectrum : g?.outSpectrum
    if (!an || out.length !== an.frequencyBinCount) return false
    an.getFloatFrequencyData(out)
    return true
  }

  /** Latest TUNER_SIZE samples of the input (after gain and phase, before any processing) */
  tunerWave(out: Float32Array<ArrayBuffer>): boolean {
    const an = this.g?.tuner
    if (!an || out.length !== an.fftSize) return false
    an.getFloatTimeDomainData(out)
    return true
  }

  /** Processed signal as a stream (to feed the studio analyzers), null when off */
  outputStream(): MediaStream | null {
    return this.g?.outStream.stream ?? null
  }
}

function emptyReports(): { gateOpen: boolean; gateDb: number; gateLevel: number; deess: number; comp1: number; comp2: number; comp1In: number; comp2In: number; lim: number; noise: number; noiseLearning: boolean } {
  return { gateOpen: true, gateDb: 0, gateLevel: -100, deess: 0, comp1: 0, comp2: 0, comp1In: -100, comp2In: -100, lim: 0, noise: 0, noiseLearning: false }
}

function analyser(ctx: AudioContext, size: number, smoothing = 0): AnalyserNode {
  const a = ctx.createAnalyser()
  a.fftSize = size
  a.smoothingTimeConstant = smoothing
  return a
}

function chain(nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
}

function toDb(a: number): number {
  return a > 0 ? Math.max(-100, 20 * Math.log10(a)) : -100
}

function describe(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Permiso de micrófono denegado.'
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return 'Dispositivo no conectado.'
    if (err.name === 'NotReadableError') return 'Dispositivo ocupado por otra aplicación.'
    return `${err.name}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

export const processorEngine = new ProcessorEngine()
