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
