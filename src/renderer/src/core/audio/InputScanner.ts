import { isVirtualDevice } from './AudioConfig'

// Opens every audio input at once (one AudioContext) and meters each channel of each device,
// for the studio's Interfaces tab. Read-only: nothing is played or processed here.

export type ScanStatus = 'ok' | 'busy' | 'missing' | 'denied' | 'error'

export interface ScanDevice {
  deviceId: string
  label: string
  virtual: boolean
  status: ScanStatus
  error?: string
  /** Channels the device delivers through the system driver */
  channels: number
  /** Most channels the driver says it could deliver (when reported) */
  maxChannels?: number
  sampleRate?: number
}

export interface ScanState {
  running: boolean
  devices: ScanDevice[]
  sampleRate?: number
}

export interface ChannelLevel {
  peak: number
  rms: number
}

interface Opened {
  stream: MediaStream
  analysers: AnalyserNode[]
}

class InputScanner {
  private ctx: AudioContext | null = null
  private opened = new Map<string, Opened>()
  private listeners = new Set<(s: ScanState) => void>()
  private _state: ScanState = { running: false, devices: [] }
  private seq = 0
  private buf = new Float32Array(1024)
  private rescanTimer: ReturnType<typeof setTimeout> | null = null
  private onDeviceChange = (): void => {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    // Devices settle for a moment after being plugged in
    this.rescanTimer = setTimeout(() => void this.start(), 800)
  }

  get state(): ScanState {
    return this._state
  }

  onState(l: (s: ScanState) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private setState(s: ScanState): void {
    this._state = s
    this.listeners.forEach((l) => l(s))
  }

  async start(): Promise<void> {
    const seq = ++this.seq
    this.close()
    const ctx = new AudioContext({ latencyHint: 'playback' })
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    let list: MediaDeviceInfo[] = []
    try {
      list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    } catch {
      list = []
    }
    const devices: ScanDevice[] = []
    const opened = new Map<string, Opened>()
    for (const d of list) {
      const label = d.label || 'Entrada sin nombre'
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: d.deviceId }, channelCount: { ideal: 32 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        })
        if (seq !== this.seq) {
          stream.getTracks().forEach((t) => t.stop())
          break
        }
        const track = stream.getAudioTracks()[0]
        const settings = track.getSettings()
        const caps = (track.getCapabilities?.() ?? {}) as { channelCount?: { max?: number } }
        const src = ctx.createMediaStreamSource(stream)
        const channels = Math.max(1, settings.channelCount ?? src.channelCount ?? 1)
        src.channelCount = channels
        src.channelCountMode = 'explicit'
        src.channelInterpretation = 'discrete'
        const split = ctx.createChannelSplitter(channels)
        src.connect(split)
        const analysers = Array.from({ length: channels }, (_, i) => {
          const a = ctx.createAnalyser()
          a.fftSize = 1024
          a.smoothingTimeConstant = 0
          split.connect(a, i)
          // Analysers must reach the destination to be pulled; the sink is silent
          a.connect(sink)
          return a
        })
        opened.set(d.deviceId, { stream, analysers })
        track.onended = () => this.onDeviceChange()
        devices.push({ deviceId: d.deviceId, label, virtual: isVirtualDevice(label), status: 'ok', channels, maxChannels: caps.channelCount?.max, sampleRate: settings.sampleRate })
      } catch (err) {
        const name = err instanceof DOMException ? err.name : ''
        const status: ScanStatus = name === 'NotReadableError' ? 'busy' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'missing' : name === 'NotAllowedError' ? 'denied' : 'error'
        devices.push({ deviceId: d.deviceId, label, virtual: isVirtualDevice(label), status, error: err instanceof Error ? err.message : String(err), channels: 0 })
      }
    }
    if (seq !== this.seq) {
      opened.forEach((o) => o.stream.getTracks().forEach((t) => t.stop()))
      await ctx.close().catch(() => undefined)
      return
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
    this.ctx = ctx
    this.opened = opened
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
    this.setState({ running: true, devices, sampleRate: ctx.sampleRate })
  }

  stop(): void {
    this.seq++
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange)
    this.close()
    this.setState({ running: false, devices: this._state.devices })
  }

  private close(): void {
    this.opened.forEach((o) => o.stream.getTracks().forEach((t) => t.stop()))
    this.opened.clear()
    this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }

  /** Current peak/RMS (dBFS) of every channel of a device; empty when it isn't open */
  levels(deviceId: string): ChannelLevel[] {
    const o = this.opened.get(deviceId)
    if (!o) return []
    return o.analysers.map((a) => {
      if (this.buf.length !== a.fftSize) this.buf = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(this.buf)
      let peak = 0
      let sum = 0
      for (let i = 0; i < this.buf.length; i++) {
        const v = this.buf[i]
        const x = Math.abs(v)
        if (x > peak) peak = x
        sum += v * v
      }
      return { peak: toDb(peak), rms: toDb(Math.sqrt(sum / this.buf.length)) }
    })
  }
}

function toDb(a: number): number {
  return a > 0 ? Math.max(-100, 20 * Math.log10(a)) : -100
}

export const inputScanner = new InputScanner()
