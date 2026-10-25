import type { AudioProfile } from './AudioConfig'
import { analyzeFrame, MIN_DB, type LevelReading } from './LevelAnalyzer'
import { openInput, type ExternalSource, type OpenInput } from './MicrophoneService'
// no-inline: the CSP blocks data: URLs for worklet modules
import tapModuleUrl from './pcmTap.worklet.js?url&no-inline'

export type EngineStatus = 'idle' | 'starting' | 'running' | 'error' | 'disconnected'

export interface EngineState {
  status: EngineStatus
  error?: string
  label?: string
  channelCount?: number
  sampleRate?: number
}

type ReadingListener = (r: LevelReading) => void
type StateListener = (s: EngineState) => void
/** Raw post-gain PCM; `frame` is the context frame of chunk[0] */
export type PcmListener = (chunk: Float32Array, frame: number, sampleRate: number) => void

interface PcmTap {
  input: OpenInput
  disconnect: () => void
}

/** AudioContext.setSinkId isn't in the TS DOM lib yet */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

/**
 * Single owner of the live microphone. Framework-agnostic: React hooks subscribe to it.
 * Samples the analyser on every animation frame (~60 readings/s).
 */
class AudioEngine {
  private input: OpenInput | null = null
  private profile: AudioProfile | null = null
  private raf = 0
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(2048)
  private smoothed = MIN_DB
  private readingListeners = new Set<ReadingListener>()
  private stateListeners = new Set<StateListener>()
  private _state: EngineState = { status: 'idle' }
  private _spectrum: Uint8Array<ArrayBuffer> = new Uint8Array(1024)
  private _spectrumDb: Float32Array<ArrayBuffer> = new Float32Array(4096)
  private pcmListeners = new Set<PcmListener>()
  private tap: PcmTap | null = null
  private tapPending: Promise<void> | null = null
  /** Bumped by every start/stop so a slow getUserMedia can't resurrect an old input */
  private seq = 0
  private monitorDb: number | null = null
  private monitorNode: GainNode | null = null
  private outputDeviceId: string | null = null
  private spectrumSmoothing = 0.5
  private override: ExternalSource | null = null
  last: LevelReading | null = null

  get state(): EngineState {
    return this._state
  }

  private setState(s: EngineState): void {
    this._state = s
    this.stateListeners.forEach((l) => l(s))
  }

  /**
   * Analyse an external stream (a mixer bus) instead of the profile's device. Gain and
   * ballistics still come from the profile. null = back to the device.
   */
  setSourceOverride(src: ExternalSource | null): void {
    if (src?.stream === this.override?.stream && src?.label === this.override?.label) return
    this.override = src
    if (this.profile) void this.start(this.profile)
  }

  get sourceOverride(): ExternalSource | null {
    return this.override
  }

  /** `ignoreOverride`: open the profile's device even while a bus is being analysed */
  async start(profile: AudioProfile, opts: { ignoreOverride?: boolean } = {}): Promise<void> {
    this.stop()
    const seq = this.seq
    this.profile = profile
    this.setState({ status: 'starting' })
    try {
      const external = opts.ignoreOverride ? undefined : (this.override ?? undefined)
      const input = await openInput(profile, () => {
        if (this.input !== input) return
        this.stopLoop()
        this.setState({ status: 'disconnected', error: 'El micrófono se desconectó.' })
      }, external)
      // A newer start/stop happened while the device was opening: drop this one
      if (seq !== this.seq) {
        input.close()
        return
      }
      this.input = input
      input.spectrumAnalyser.smoothingTimeConstant = this.spectrumSmoothing
      this.applyOutput()
      this.applyMonitor()
      if (this.pcmListeners.size > 0) void this.ensureTap()
      this.buffer = new Float32Array(input.analyser.fftSize)
      this._spectrum = new Uint8Array(input.analyser.frequencyBinCount)
      this.smoothed = MIN_DB
      this.setState({
        status: 'running',
        label: input.label,
        channelCount: input.channelCount,
        sampleRate: input.sampleRate
      })
      this.loop()
    } catch (err) {
      if (seq !== this.seq) return
      this.input = null
      this.setState({ status: 'error', error: describeError(err) })
    }
  }

  /** Restart with the same profile (e.g. after a device reconnects) */
  async restart(): Promise<void> {
    if (this.profile) await this.start(this.profile)
  }

  stop(): void {
    this.seq++
    this.stopLoop()
    this.tap?.disconnect()
    this.tap = null
    this.tapPending = null
    this.monitorNode?.disconnect()
    this.monitorNode = null
    this.input?.close()
    this.input = null
    if (this._state.status !== 'idle') this.setState({ status: 'idle' })
  }

  private stopLoop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private loop = (): void => {
    if (!this.input || !this.profile) return
    this.input.analyser.getFloatTimeDomainData(this.buffer)
    const reading = analyzeFrame(
      this.buffer,
      performance.now(),
      this.smoothed,
      this.profile.ballistics,
      this.profile.gateDb
    )
    this.smoothed = reading.smoothedDb
    this.last = reading
    this.readingListeners.forEach((l) => l(reading))
    this.raf = requestAnimationFrame(this.loop)
  }

  spectrum(): Uint8Array | null {
    if (!this.input) return null
    this.input.analyser.getByteFrequencyData(this._spectrum)
    return this._spectrum
  }

  /** Last analysed time-domain frame (post-gain), for oscilloscope views */
  waveform(): Float32Array | null {
    return this.input ? this.buffer : null
  }

  /** High-resolution spectrum in dBFS per bin (8192 FFT), for the studio */
  spectrumDb(): { data: Float32Array; sampleRate: number; fftSize: number } | null {
    if (!this.input) return null
    const a = this.input.spectrumAnalyser
    if (this._spectrumDb.length !== a.frequencyBinCount) this._spectrumDb = new Float32Array(a.frequencyBinCount)
    a.getFloatFrequencyData(this._spectrumDb)
    return { data: this._spectrumDb, sampleRate: this.input.sampleRate, fftSize: a.fftSize }
  }

  /** Analyzer averaging 0..0.95 (higher = steadier display) */
  setSpectrumSmoothing(v: number): void {
    this.spectrumSmoothing = Math.min(0.95, Math.max(0, v))
    if (this.input) this.input.spectrumAnalyser.smoothingTimeConstant = this.spectrumSmoothing
  }

  get sampleRate(): number {
    return this.input?.sampleRate ?? 48000
  }

  /** Latencies the browser reports for the input context, in ms */
  reportedLatency(): { baseMs: number; outputMs: number } | null {
    const ctx = this.input?.context
    if (!ctx) return null
    return { baseMs: (ctx.baseLatency ?? 0) * 1000, outputMs: (ctx.outputLatency ?? 0) * 1000 }
  }

  // ---- Raw PCM tap (AudioWorklet, ScriptProcessor fallback), only while someone listens

  onPcm(l: PcmListener): () => void {
    this.pcmListeners.add(l)
    void this.ensureTap()
    return () => {
      this.pcmListeners.delete(l)
      if (this.pcmListeners.size === 0) {
        this.tap?.disconnect()
        this.tap = null
      }
    }
  }

  private ensureTap(): Promise<void> {
    const input = this.input
    if (!input || this.tap?.input === input) return Promise.resolve()
    if (this.tapPending) return this.tapPending
    const emit = (data: Float32Array, frame: number): void => this.pcmListeners.forEach((l) => l(data, frame, input.sampleRate))
    const pending: Promise<void> = createTap(input, emit)
      .then((tap) => {
        // The input changed or everyone unsubscribed while the module loaded
        if (this.input !== input || this.pcmListeners.size === 0) tap.disconnect()
        else this.tap = tap
      })
      .catch((err) => console.error('PCM tap', err))
      .finally(() => {
        if (this.tapPending === pending) this.tapPending = null
      })
    this.tapPending = pending
    return pending
  }

  // ---- Monitoring and output routing

  /** Headphone monitoring of the input at `db` (null = off). Survives restarts. */
  setMonitor(db: number | null): void {
    this.monitorDb = db
    this.applyMonitor()
  }

  private applyMonitor(): void {
    const input = this.input
    if (!input) return
    if (this.monitorDb === null) {
      this.monitorNode?.disconnect()
      this.monitorNode = null
      return
    }
    if (!this.monitorNode) {
      this.monitorNode = input.context.createGain()
      this.monitorNode.gain.value = 0
      input.tap.connect(this.monitorNode)
      this.monitorNode.connect(input.context.destination)
    }
    this.monitorNode.gain.setTargetAtTime(Math.pow(10, this.monitorDb / 20), input.context.currentTime, 0.02)
  }

  /** Output device for monitoring and scheduled test signals (null = default) */
  setOutputDevice(id: string | null): void {
    this.outputDeviceId = id
    this.applyOutput()
  }

  private applyOutput(): void {
    const ctx = this.input?.context as SinkContext | undefined
    if (!ctx?.setSinkId) return
    ctx.setSinkId(this.outputDeviceId ?? '').catch(() => undefined)
  }

  /**
   * Plays `samples` through the input's own context (same clock as the PCM tap) after
   * `delayS`. Returns the context frame where playback starts, or null without input.
   */
  scheduleOutput(samples: Float32Array, delayS = 0.3): number | null {
    const input = this.input
    if (!input) return null
    const ctx = input.context
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    const when = ctx.currentTime + delayS
    src.onended = () => src.disconnect()
    src.start(when)
    return Math.round(when * ctx.sampleRate)
  }

  /**
   * Records a take: level readings, the linear power spectrum averaged over frames
   * louder than `voicedAboveDb`, and raw post-gain PCM for playback/WAV export.
   */
  captureTake(
    ms: number,
    voicedAboveDb: number
  ): Promise<{ frames: LevelReading[]; power: Float64Array; pcm: Float32Array; sampleRate: number; fftSize: number }> {
    const input = this.input
    if (!input) return Promise.reject(new Error('El micrófono no está abierto.'))
    const fftSize = input.spectrumAnalyser.fftSize
    const bins = input.spectrumAnalyser.frequencyBinCount
    const voicedPower = new Float64Array(bins)
    const allPower = new Float64Array(bins)
    let voicedCount = 0
    let allCount = 0
    const frames: LevelReading[] = []
    const chunks: Float32Array[] = []

    const offPcm = this.onPcm((c) => chunks.push(c))
    const off = this.onReading((r) => {
      frames.push(r)
      const s = this.spectrumDb()
      if (!s) return
      const voiced = r.rmsDb > voicedAboveDb
      for (let i = 0; i < bins; i++) {
        const p = Math.pow(10, s.data[i] / 10)
        allPower[i] += p
        if (voiced) voicedPower[i] += p
      }
      allCount++
      if (voiced) voicedCount++
    })

    return new Promise((resolve) => {
      setTimeout(() => {
        off()
        offPcm()
        // Fall back to every frame if nothing cleared the voiced threshold
        const [power, n] = voicedCount > 0 ? [voicedPower, voicedCount] : [allPower, allCount]
        if (n > 0) for (let i = 0; i < bins; i++) power[i] /= n
        resolve({ frames, power, pcm: joinChunks(chunks), sampleRate: input.sampleRate, fftSize })
      }, ms)
    })
  }

  onReading(l: ReadingListener): () => void {
    this.readingListeners.add(l)
    return () => this.readingListeners.delete(l)
  }

  onState(l: StateListener): () => void {
    this.stateListeners.add(l)
    return () => this.stateListeners.delete(l)
  }

  /** Collects readings for `ms` milliseconds */
  record(ms: number): Promise<LevelReading[]> {
    return new Promise((resolve) => {
      const frames: LevelReading[] = []
      const off = this.onReading((r) => frames.push(r))
      setTimeout(() => {
        off()
        resolve(frames)
      }, ms)
    })
  }
}

export function joinChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

const workletLoaded = new WeakSet<BaseAudioContext>()

async function createTap(input: OpenInput, emit: (data: Float32Array, frame: number) => void): Promise<PcmTap> {
  const ctx = input.context
  // Kept silent but connected so the graph keeps pulling the node
  const mute = ctx.createGain()
  mute.gain.value = 0
  mute.connect(ctx.destination)
  const unplug = (node: AudioNode): void => {
    node.disconnect()
    mute.disconnect()
    try {
      input.tap.disconnect(node)
    } catch {
      /* already gone */
    }
  }
  try {
    if (!workletLoaded.has(ctx)) {
      await ctx.audioWorklet.addModule(tapModuleUrl)
      workletLoaded.add(ctx)
    }
    const node = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
    node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) => emit(e.data.data, e.data.frame)
    input.tap.connect(node)
    node.connect(mute)
    return {
      input,
      disconnect: () => {
        node.port.onmessage = null
        unplug(node)
      }
    }
  } catch {
    // ScriptProcessor is deprecated but universally available
    const size = 2048
    const proc = ctx.createScriptProcessor(size, 1, 1)
    proc.onaudioprocess = (e) => emit(new Float32Array(e.inputBuffer.getChannelData(0)), Math.round(e.playbackTime * ctx.sampleRate) - size)
    input.tap.connect(proc)
    proc.connect(mute)
    return {
      input,
      disconnect: () => {
        proc.onaudioprocess = null
        unplug(proc)
      }
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Permiso de micrófono denegado.'
    if (err.name === 'NotFoundError') return 'No se encontró el micrófono seleccionado.'
    if (err.name === 'NotReadableError') return 'El micrófono está ocupado por otra aplicación.'
    if (err.name === 'OverconstrainedError') return 'El dispositivo no admite esa configuración (prueba otra frecuencia de muestreo).'
    return `${err.name}: ${err.message}`
  }
  return String(err)
}

export const audioEngine = new AudioEngine()
