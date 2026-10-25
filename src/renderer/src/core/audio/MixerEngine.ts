import type { Bus, MixerConfig, Strip } from '../mixer/mixer'
import { dbToGain, duckStep, MAX_NOTCHES, monitorFeed, stripOutputGain } from '../mixer/mixer'
import { compressorAutoMakeupDb } from '../studio/dsp'
import { isVirtualDevice } from './AudioConfig'
// no-inline: the CSP blocks data: URLs for worklet modules
import busTapUrl from './busTap.worklet.js?url&no-inline'
import gateUrl from './stripGate.worklet.js?url&no-inline'

// Web Audio graph of the virtual mixer. One AudioContext; every input device is opened once
// and split into channels; each strip is a mono (or stereo) channel strip feeding buses.
//
// strip: in(trim) → phase → HPF → notch×6 → gate → EQ×4 → comp → makeup → limiter → delay
//        → [pre-fader meters, cue] → fader → duck → pan → sends
// bus:   sum → limiter → (stereo | mono) → fader → meters → output device / stream
// monitor (optional): cued strips pre-fader, or one bus → level → its own output device

export type MixerStatus = 'off' | 'starting' | 'on' | 'error'

export interface MixerState {
  status: MixerStatus
  error?: string
  /** Per-strip problems (device missing, channel out of range…) */
  stripErrors: Record<string, string>
  sampleRate?: number
  /** Bumped on every (re)build so stream consumers can re-attach */
  generation: number
}

export interface ChannelLevel {
  peakL: number
  peakR: number
  rmsL: number
  rmsR: number
}

export interface StripLevel extends ChannelLevel {
  /** Pre-fader input peak (after trim), for gain staging */
  inPeak: number
  /** After processing, before the fader */
  prePeakL: number
  prePeakR: number
  /** Channel limiter gain reduction, dB (≤ 0) */
  limGr: number
  /** Current ducking attenuation, dB (≤ 0) */
  duckDb: number
  /** Compressor gain reduction, dB (≤ 0) */
  gr: number
  gateOpen: boolean
}

export interface BusLevel extends ChannelLevel {
  gr: number
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

interface SourceNodes {
  stream: MediaStream
  node: MediaStreamAudioSourceNode
  splitter: ChannelSplitterNode
  channels: number
  label: string
}

interface StripNodes {
  input: GainNode
  inMeter: AnalyserNode
  phase: GainNode
  hpf: BiquadFilterNode
  notches: BiquadFilterNode[]
  gate: AudioWorkletNode
  gateOpen: boolean
  eq: BiquadFilterNode[]
  comp: DynamicsCompressorNode
  makeup: GainNode
  limiter: DynamicsCompressorNode
  limiterTrim: GainNode
  delay: DelayNode
  preL: AnalyserNode
  preR: AnalyserNode
  /** Large FFT on the pre-fader signal, for the feedback detector */
  spectrum: AnalyserNode
  cue: GainNode
  fader: GainNode
  duck: GainNode
  duckDb: number
  pan: StereoPannerNode
  meterL: AnalyserNode
  meterR: AnalyserNode
  sends: Map<string, GainNode>
}

interface BusNodes {
  sum: GainNode
  limiter: DynamicsCompressorNode
  limiterTrim: GainNode
  stereo: GainNode
  mono: GainNode
  fader: GainNode
  meterL: AnalyserNode
  meterR: AnalyserNode
  stream: MediaStreamAudioDestinationNode
  audio: SinkAudio | null
  usesDestination: boolean
  recorder: { node: AudioWorkletNode; left: Float32Array[]; right: Float32Array[] } | null
}

interface MonitorNodes {
  sum: GainNode
  level: GainNode
  stream: MediaStreamAudioDestinationNode
  audio: SinkAudio
  busSends: Map<string, GainNode>
}

const TC = 0.015
export const SPECTRUM_FFT = 8192

/** Inputs whose identity requires reopening devices or rewiring when they change */
export function structureKey(cfg: Pick<MixerConfig, 'strips' | 'buses' | 'sampleRate'> & Partial<Pick<MixerConfig, 'monitor'>>): string {
  return JSON.stringify({
    sr: cfg.sampleRate,
    strips: cfg.strips.map((s) => [s.id, s.input.deviceId, s.input.mode, s.input.left, s.input.right]),
    buses: cfg.buses.map((b) => [b.id, b.kind]),
    monitor: !!cfg.monitor?.on
  })
}

class MixerEngine {
  private ctx: SinkContext | null = null
  private sources = new Map<string, SourceNodes>()
  private strips = new Map<string, StripNodes>()
  private buses = new Map<string, BusNodes>()
  private monitor: MonitorNodes | null = null
  private duckTimer: ReturnType<typeof setInterval> | null = null
  private key = ''
  /** Newest config seen, so edits made while starting aren't lost */
  private latest: MixerConfig | null = null
  private seq = 0
  private listeners = new Set<(s: MixerState) => void>()
  private _state: MixerState = { status: 'off', stripErrors: {}, generation: 0 }
  private buf = new Float32Array(1024)

  get state(): MixerState {
    return this._state
  }

  get running(): boolean {
    return this._state.status === 'on'
  }

  onState(l: (s: MixerState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setState(patch: Partial<MixerState>): void {
    this._state = { ...this._state, ...patch }
    this.listeners.forEach((l) => l(this._state))
  }

  async start(cfg: MixerConfig): Promise<void> {
    this.latest = cfg
    this.teardown()
    const seq = ++this.seq
    this.setState({ status: 'starting', error: undefined, stripErrors: {} })
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive', ...(cfg.sampleRate ? { sampleRate: cfg.sampleRate } : {}) }) as SinkContext
      await Promise.all([ctx.audioWorklet.addModule(gateUrl), ctx.audioWorklet.addModule(busTapUrl)])
      const stripErrors: Record<string, string> = {}
      // Open every distinct device once
      const devices = [...new Set(cfg.strips.map((s) => s.input.deviceId ?? ''))]
      const opened = new Map<string, SourceNodes>()
      for (const id of devices) {
        try {
          opened.set(id, await openSource(ctx, id || null))
        } catch (err) {
          for (const s of cfg.strips) if ((s.input.deviceId ?? '') === id) stripErrors[s.id] = describe(err)
        }
      }
      if (seq !== this.seq) {
        opened.forEach((s) => s.stream.getTracks().forEach((t) => t.stop()))
        await ctx.close()
        return
      }
      this.ctx = ctx
      this.sources = opened
      for (const b of cfg.buses) this.buses.set(b.id, this.buildBus(ctx, b, cfg))
      if (cfg.monitor?.on) this.monitor = this.buildMonitor(ctx)
      for (const s of cfg.strips) {
        const src = this.sources.get(s.input.deviceId ?? '')
        if (!src) continue
        const needed = s.input.mode === 'stereo' ? Math.max(s.input.left, s.input.right) : s.input.mode === 'mono' ? s.input.left : 0
        if (s.input.mode !== 'mix' && needed >= src.channels) {
          stripErrors[s.id] = `El dispositivo solo tiene ${src.channels} canal${src.channels === 1 ? '' : 'es'}.`
          continue
        }
        this.strips.set(s.id, this.buildStrip(ctx, s, src))
      }
      this.key = structureKey(cfg)
      const newest = this.latest && structureKey(this.latest) === this.key ? this.latest : cfg
      this.applyParams(newest)
      if (ctx.state === 'suspended') await ctx.resume()
      this.duckTimer = setInterval(() => this.duckTick(20), 20)
      this.setState({ status: 'on', stripErrors, sampleRate: ctx.sampleRate, generation: this._state.generation + 1 })
      // Structure edited while the devices were opening: rebuild once more with it
      if (this.latest && structureKey(this.latest) !== this.key) void this.start(this.latest)
    } catch (err) {
      if (seq !== this.seq) return
      this.teardown()
      this.setState({ status: 'error', error: describe(err) })
    }
  }

  stop(): void {
    this.seq++
    this.teardown()
    this.setState({ status: 'off', stripErrors: {}, error: undefined })
  }

  /** Applies a new config: parameters live, structural changes rebuild the graph */
  apply(cfg: MixerConfig): void {
    this.latest = cfg
    if (this._state.status === 'off' || this._state.status === 'error') return
    if (this._state.status === 'starting' && !this.key) return
    if (structureKey(cfg) !== this.key) {
      void this.start(cfg)
      return
    }
    this.applyParams(cfg)
  }

  private teardown(): void {
    if (this.duckTimer) clearInterval(this.duckTimer)
    this.duckTimer = null
    if (this.monitor) {
      this.monitor.audio.pause()
      this.monitor.audio.srcObject = null
      this.monitor = null
    }
    for (const b of this.buses.values()) {
      if (b.audio) {
        b.audio.pause()
        b.audio.srcObject = null
      }
    }
    this.sources.forEach((s) => s.stream.getTracks().forEach((t) => t.stop()))
    this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.sources.clear()
    this.strips.clear()
    this.buses.clear()
    this.key = ''
  }

  private buildStrip(ctx: AudioContext, s: Strip, src: SourceNodes): StripNodes {
    const stereo = s.input.mode === 'stereo'
    const nch = stereo ? 2 : 1
    const input = ctx.createGain()
    input.channelCount = nch
    input.channelCountMode = 'explicit'
    input.channelInterpretation = 'speakers'
    if (s.input.mode === 'mix') {
      src.node.connect(input)
    } else if (stereo) {
      const merger = ctx.createChannelMerger(2)
      src.splitter.connect(merger, s.input.left, 0)
      src.splitter.connect(merger, s.input.right, 1)
      merger.connect(input)
    } else {
      src.splitter.connect(input, s.input.left)
    }
    const inMeter = analyser(ctx)
    input.connect(inMeter)
    const phase = ctx.createGain()
    const hpf = ctx.createBiquadFilter()
    hpf.type = 'highpass'
    // Web Audio's low/high-pass Q is in dB: −3.01 dB = Butterworth
    hpf.Q.value = -3.01
    // Notches always exist (0 dB when unused) so adding one never rebuilds the graph
    const notches = Array.from({ length: MAX_NOTCHES }, () => {
      const f = ctx.createBiquadFilter()
      f.type = 'peaking'
      f.gain.value = 0
      return f
    })
    const spectrum = ctx.createAnalyser()
    spectrum.fftSize = SPECTRUM_FFT
    spectrum.smoothingTimeConstant = 0.5
    const gate = new AudioWorkletNode(ctx, 'strip-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [nch], channelCount: nch, channelCountMode: 'explicit' })
    const nodes: StripNodes = {
      input,
      inMeter,
      phase,
      hpf,
      notches,
      gate,
      gateOpen: true,
      eq: s.eq.bands.map(() => ctx.createBiquadFilter()),
      comp: ctx.createDynamicsCompressor(),
      makeup: ctx.createGain(),
      limiter: ctx.createDynamicsCompressor(),
      limiterTrim: ctx.createGain(),
      delay: ctx.createDelay(0.5),
      preL: analyser(ctx),
      preR: analyser(ctx),
      spectrum,
      cue: ctx.createGain(),
      fader: ctx.createGain(),
      duck: ctx.createGain(),
      duckDb: 0,
      pan: ctx.createStereoPanner(),
      meterL: analyser(ctx),
      meterR: analyser(ctx),
      sends: new Map()
    }
    gate.port.onmessage = (e: MessageEvent<{ open: boolean }>) => {
      nodes.gateOpen = e.data.open
    }
    chain([input, phase, hpf, ...notches, gate, ...nodes.eq, nodes.comp, nodes.makeup, nodes.limiter, nodes.limiterTrim, nodes.delay, nodes.fader, nodes.duck, nodes.pan])
    const preSplit = ctx.createChannelSplitter(2)
    nodes.delay.connect(preSplit)
    preSplit.connect(nodes.preL, 0)
    // A mono strip only fills the first channel: its right meter reads the same as the left
    preSplit.connect(nodes.preR, stereo ? 1 : 0)
    nodes.delay.connect(spectrum)
    nodes.cue.gain.value = 0
    nodes.delay.connect(nodes.cue)
    if (this.monitor) nodes.cue.connect(this.monitor.sum)
    const split = ctx.createChannelSplitter(2)
    nodes.pan.connect(split)
    split.connect(nodes.meterL, 0)
    split.connect(nodes.meterR, 1)
    for (const [id, bus] of this.buses) {
      const send = ctx.createGain()
      send.gain.value = 0
      nodes.pan.connect(send).connect(bus.sum)
      nodes.sends.set(id, send)
    }
    return nodes
  }

  private buildBus(ctx: SinkContext, b: Bus, cfg: MixerConfig): BusNodes {
    const sum = ctx.createGain()
    sum.channelCount = 2
    sum.channelCountMode = 'explicit'
    const limiter = ctx.createDynamicsCompressor()
    const limiterTrim = ctx.createGain()
    const stereo = ctx.createGain()
    const mono = ctx.createGain()
    // Down-mixing to one channel and back up gives (L+R)/2 on both sides
    mono.channelCount = 1
    mono.channelCountMode = 'explicit'
    mono.channelInterpretation = 'speakers'
    const fader = ctx.createGain()
    sum.connect(limiter).connect(limiterTrim)
    limiterTrim.connect(stereo).connect(fader)
    limiterTrim.connect(mono).connect(fader)
    const meterL = analyser(ctx)
    const meterR = analyser(ctx)
    const split = ctx.createChannelSplitter(2)
    fader.connect(split)
    split.connect(meterL, 0)
    split.connect(meterR, 1)
    const stream = ctx.createMediaStreamDestination()
    fader.connect(stream)
    // The first output bus uses the context's own (lowest-latency) output, others an <audio> sink
    const firstOut = cfg.buses.find((x) => x.kind === 'out')?.id === b.id
    let audio: SinkAudio | null = null
    if (b.kind === 'out') {
      if (firstOut) {
        fader.connect(ctx.destination)
        ctx.setSinkId?.(b.deviceId ?? '').catch(() => undefined)
      } else {
        audio = new Audio() as SinkAudio
        audio.srcObject = stream.stream
        audio.setSinkId?.(b.deviceId ?? '').catch(() => undefined)
        void audio.play().catch(() => undefined)
      }
    }
    return { sum, limiter, limiterTrim, stereo, mono, fader, meterL, meterR, stream, audio, usesDestination: firstOut && b.kind === 'out', recorder: null }
  }

  /** Headphone output: built after the buses, before the strips (they connect their cue to it) */
  private buildMonitor(ctx: AudioContext): MonitorNodes {
    const sum = ctx.createGain()
    sum.channelCount = 2
    sum.channelCountMode = 'explicit'
    sum.channelInterpretation = 'speakers'
    const level = ctx.createGain()
    const stream = ctx.createMediaStreamDestination()
    sum.connect(level).connect(stream)
    const busSends = new Map<string, GainNode>()
    for (const [id, bus] of this.buses) {
      const g = ctx.createGain()
      g.gain.value = 0
      bus.fader.connect(g).connect(sum)
      busSends.set(id, g)
    }
    const audio = new Audio() as SinkAudio
    audio.srcObject = stream.stream
    void audio.play().catch(() => undefined)
    return { sum, level, stream, audio, busSends }
  }

  /** Ducking runs on a timer: it follows the source strip's pre-fader level */
  private duckTick(dtMs: number): void {
    const cfg = this.latest
    const ctx = this.ctx
    if (!cfg || !ctx) return
    for (const s of cfg.strips) {
      const n = this.strips.get(s.id)
      if (!n) continue
      const src = s.duck.on && s.duck.sourceId && s.duck.sourceId !== s.id ? this.strips.get(s.duck.sourceId) : undefined
      const sourceDb = src ? Math.max(this.level(src.preL).peak, this.level(src.preR).peak) : -100
      const next = src ? duckStep(n.duckDb, sourceDb, s.duck, dtMs) : 0
      if (next === n.duckDb) continue
      n.duckDb = next
      n.duck.gain.setTargetAtTime(Math.pow(10, next / 20), ctx.currentTime, 0.005)
    }
  }

  private applyParams(cfg: MixerConfig): void {
    const ctx = this.ctx
    if (!ctx) return
    const t = ctx.currentTime
    const set = (p: AudioParam, v: number): void => {
      p.setTargetAtTime(v, t, TC)
    }
    for (const s of cfg.strips) {
      const n = this.strips.get(s.id)
      if (!n) continue
      set(n.input.gain, Math.pow(10, s.trimDb / 20))
      set(n.phase.gain, s.phaseInvert ? -1 : 1)
      // Bypass = 10 Hz corner: inaudible, and no graph rewiring
      set(n.hpf.frequency, s.hpf.on ? s.hpf.hz : 10)
      n.notches.forEach((f, i) => {
        const x = s.notches[i]
        set(f.frequency, x ? x.hz : 1000)
        set(f.Q, x ? x.q : 1)
        set(f.gain, x ? x.gainDb : 0)
      })
      setParam(n.gate, 'enabled', s.gate.on ? 1 : 0)
      setParam(n.gate, 'threshold', s.gate.thresholdDb)
      setParam(n.gate, 'range', s.gate.rangeDb)
      setParam(n.gate, 'attack', s.gate.attackMs)
      setParam(n.gate, 'hold', s.gate.holdMs)
      setParam(n.gate, 'release', s.gate.releaseMs)
      s.eq.bands.forEach((b, i) => {
        const f = n.eq[i]
        if (!f) return
        f.type = b.type
        set(f.frequency, b.freq)
        set(f.Q, b.q)
        set(f.gain, s.eq.on ? b.gainDb : 0)
      })
      const c = s.comp
      const thr = c.on ? c.thresholdDb : 0
      const ratio = c.on ? c.ratio : 1
      const knee = c.on ? c.kneeDb : 0
      set(n.comp.threshold, thr)
      set(n.comp.ratio, ratio)
      set(n.comp.knee, knee)
      n.comp.attack.setValueAtTime(c.attackMs / 1000, t)
      n.comp.release.setValueAtTime(c.releaseMs / 1000, t)
      set(n.makeup.gain, Math.pow(10, ((c.on ? c.makeupDb : 0) - compressorAutoMakeupDb(thr, ratio, knee)) / 20))
      const lim = s.limiter
      set(n.limiter.threshold, lim.on ? lim.ceilingDb : 0)
      set(n.limiter.ratio, lim.on ? 20 : 1)
      n.limiter.knee.setValueAtTime(0, t)
      n.limiter.attack.setValueAtTime(0.001, t)
      n.limiter.release.setValueAtTime(0.06, t)
      set(n.limiterTrim.gain, Math.pow(10, -compressorAutoMakeupDb(lim.on ? lim.ceilingDb : 0, lim.on ? 20 : 1, 0) / 20))
      set(n.delay.delayTime, Math.max(0, Math.min(500, s.delayMs)) / 1000)
      set(n.fader.gain, stripOutputGain(s, cfg.strips))
      set(n.pan.pan, s.pan)
      for (const [busId, send] of n.sends) set(send.gain, s.sends.includes(busId) ? 1 : 0)
      if (!s.duck.on && n.duckDb !== 0) {
        n.duckDb = 0
        set(n.duck.gain, 1)
      }
    }
    const feed = cfg.monitor ? monitorFeed(cfg) : null
    for (const s of cfg.strips) {
      const n = this.strips.get(s.id)
      if (n) set(n.cue.gain, this.monitor && feed?.kind === 'cue' && feed.strips.includes(s.id) ? 1 : 0)
    }
    if (this.monitor && feed && cfg.monitor) {
      for (const [id, g] of this.monitor.busSends) set(g.gain, feed.kind === 'bus' && feed.bus === id ? 1 : 0)
      set(this.monitor.level.gain, dbToGain(cfg.monitor.levelDb))
      this.monitor.audio.setSinkId?.(cfg.monitor.deviceId ?? '').catch(() => undefined)
    }
    for (const b of cfg.buses) {
      const n = this.buses.get(b.id)
      if (!n) continue
      set(n.limiter.threshold, b.limiter ? -1 : 0)
      set(n.limiter.ratio, b.limiter ? 20 : 1)
      n.limiter.knee.setValueAtTime(0, t)
      n.limiter.attack.setValueAtTime(0.001, t)
      n.limiter.release.setValueAtTime(0.08, t)
      set(n.limiterTrim.gain, Math.pow(10, -compressorAutoMakeupDb(b.limiter ? -1 : 0, b.limiter ? 20 : 1, 0) / 20))
      set(n.stereo.gain, b.mono ? 0 : 1)
      set(n.mono.gain, b.mono ? 1 : 0)
      set(n.fader.gain, b.mute ? 0 : dbToGain(b.faderDb))
      if (b.kind === 'out') {
        if (n.usesDestination) this.ctx?.setSinkId?.(b.deviceId ?? '').catch(() => undefined)
        else n.audio?.setSinkId?.(b.deviceId ?? '').catch(() => undefined)
      }
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

  stripLevel(id: string): StripLevel | null {
    const n = this.strips.get(id)
    if (!n) return null
    const l = this.level(n.meterL)
    const r = this.level(n.meterR)
    return {
      peakL: l.peak,
      peakR: r.peak,
      rmsL: l.rms,
      rmsR: r.rms,
      inPeak: this.level(n.inMeter).peak,
      prePeakL: this.level(n.preL).peak,
      prePeakR: this.level(n.preR).peak,
      gr: n.comp.reduction,
      limGr: n.limiter.reduction,
      duckDb: n.duckDb,
      gateOpen: n.gateOpen
    }
  }

  /** Pre-fader spectrum of a strip in dB per bin (SPECTRUM_FFT / 2 bins); false when off */
  stripSpectrum(id: string, out: Float32Array<ArrayBuffer>): boolean {
    const n = this.strips.get(id)
    if (!n || out.length !== n.spectrum.frequencyBinCount) return false
    n.spectrum.getFloatFrequencyData(out)
    return true
  }

  get monitorOn(): boolean {
    return !!this.monitor
  }

  busLevel(id: string): BusLevel | null {
    const n = this.buses.get(id)
    if (!n) return null
    const l = this.level(n.meterL)
    const r = this.level(n.meterR)
    return { peakL: l.peak, peakR: r.peak, rmsL: l.rms, rmsR: r.rms, gr: n.limiter.reduction }
  }

  // ---- Bus streams and recording

  /** Live stereo stream of a bus (for the studio analyzers), null when off */
  busStream(id: string): MediaStream | null {
    return this.buses.get(id)?.stream.stream ?? null
  }

  isRecording(id: string): boolean {
    return !!this.buses.get(id)?.recorder
  }

  startRecording(id: string): boolean {
    const ctx = this.ctx
    const bus = this.buses.get(id)
    if (!ctx || !bus || bus.recorder) return false
    const node = new AudioWorkletNode(ctx, 'bus-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' })
    const rec = { node, left: [] as Float32Array[], right: [] as Float32Array[] }
    node.port.onmessage = (e: MessageEvent<{ left: Float32Array; right: Float32Array }>) => {
      rec.left.push(e.data.left)
      rec.right.push(e.data.right)
    }
    const mute = ctx.createGain()
    mute.gain.value = 0
    bus.fader.connect(node)
    node.connect(mute).connect(ctx.destination)
    bus.recorder = rec
    return true
  }

  async stopRecording(id: string): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number } | null> {
    const bus = this.buses.get(id)
    const rec = bus?.recorder
    if (!bus || !rec || !this.ctx) return null
    const sampleRate = this.ctx.sampleRate
    rec.node.port.postMessage('flush')
    await new Promise((r) => setTimeout(r, 120))
    rec.node.port.onmessage = null
    rec.node.disconnect()
    try {
      bus.fader.disconnect(rec.node)
    } catch {
      /* already gone */
    }
    bus.recorder = null
    return { left: join(rec.left), right: join(rec.right), sampleRate }
  }

  /** Recording time so far in seconds */
  recordedSeconds(id: string): number {
    const rec = this.buses.get(id)?.recorder
    if (!rec || !this.ctx) return 0
    return rec.left.reduce((n, c) => n + c.length, 0) / this.ctx.sampleRate
  }

  /** Channel count and name of each opened input device */
  deviceInfo(): { deviceId: string; label: string; channels: number; virtual: boolean }[] {
    return [...this.sources.entries()].map(([id, s]) => ({ deviceId: id, label: s.label, channels: s.channels, virtual: isVirtualDevice(s.label) }))
  }
}

async function openSource(ctx: AudioContext, deviceId: string | null): Promise<SourceNodes> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Ask for many channels so interfaces expose every input
    channelCount: { ideal: 32 }
  }
  if (deviceId && deviceId !== 'default') constraints.deviceId = { exact: deviceId }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  const track = stream.getAudioTracks()[0]
  const node = ctx.createMediaStreamSource(stream)
  const channels = Math.max(1, track.getSettings().channelCount ?? node.channelCount ?? 1)
  node.channelCount = channels
  node.channelCountMode = 'explicit'
  node.channelInterpretation = 'discrete'
  const splitter = ctx.createChannelSplitter(Math.max(2, channels))
  node.connect(splitter)
  return { stream, node, splitter, channels, label: track.label }
}

function analyser(ctx: AudioContext): AnalyserNode {
  const a = ctx.createAnalyser()
  a.fftSize = 1024
  a.smoothingTimeConstant = 0
  return a
}

function chain(nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
}

function setParam(node: AudioWorkletNode, name: string, value: number): void {
  node.parameters.get(name)?.setValueAtTime(value, node.context.currentTime)
}

function toDb(a: number): number {
  return a > 0 ? Math.max(-100, 20 * Math.log10(a)) : -100
}

function join(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
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

export const mixerEngine = new MixerEngine()
