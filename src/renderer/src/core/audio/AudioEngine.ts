import type { AudioProfile } from './AudioConfig'
import { analyzeFrame, MIN_DB, type LevelReading } from './LevelAnalyzer'
import { openInput, type OpenInput } from './MicrophoneService'

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
  last: LevelReading | null = null

  get state(): EngineState {
    return this._state
  }

  private setState(s: EngineState): void {
    this._state = s
    this.stateListeners.forEach((l) => l(s))
  }

  async start(profile: AudioProfile): Promise<void> {
    this.stop()
    this.profile = profile
    this.setState({ status: 'starting' })
    try {
      this.input = await openInput(profile, () => {
        this.stopLoop()
        this.setState({ status: 'disconnected', error: 'El micrófono se desconectó.' })
      })
      this.buffer = new Float32Array(this.input.analyser.fftSize)
      this._spectrum = new Uint8Array(this.input.analyser.frequencyBinCount)
      this.smoothed = MIN_DB
      this.setState({
        status: 'running',
        label: this.input.label,
        channelCount: this.input.channelCount,
        sampleRate: this.input.sampleRate
      })
      this.loop()
    } catch (err) {
      this.input = null
      this.setState({ status: 'error', error: describeError(err) })
    }
  }

  /** Restart with the same profile (e.g. after a device reconnects) */
  async restart(): Promise<void> {
    if (this.profile) await this.start(this.profile)
  }

  stop(): void {
    this.stopLoop()
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

    // ScriptProcessor is deprecated but universally available and enough for a mono tap
    const proc = input.context.createScriptProcessor(4096, 1, 1)
    const mute = input.context.createGain()
    mute.gain.value = 0
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    input.tap.connect(proc)
    proc.connect(mute).connect(input.context.destination)

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
        proc.disconnect()
        mute.disconnect()
        // Fall back to every frame if nothing cleared the voiced threshold
        const [power, n] = voicedCount > 0 ? [voicedPower, voicedCount] : [allPower, allCount]
        if (n > 0) for (let i = 0; i < bins; i++) power[i] /= n
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const pcm = new Float32Array(total)
        let o = 0
        for (const c of chunks) {
          pcm.set(c, o)
          o += c.length
        }
        resolve({ frames, power, pcm, sampleRate: input.sampleRate, fftSize })
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
