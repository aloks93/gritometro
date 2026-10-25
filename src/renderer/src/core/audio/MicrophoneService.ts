import type { AudioProfile } from './AudioConfig'
import { isVirtualDevice } from './AudioConfig'

export interface InputDevice {
  deviceId: string
  label: string
  virtual: boolean
}

export interface OpenInput {
  context: AudioContext
  analyser: AnalyserNode
  /** High-resolution analyser (8192 FFT) for the studio spectrum */
  spectrumAnalyser: AnalyserNode
  /** Post-gain node to tap for raw PCM capture */
  tap: AudioNode
  stream: MediaStream
  /** Channels reported by the device */
  channelCount: number
  sampleRate: number
  label: string
  close: () => void
}

/** Labels are only exposed after mic permission is granted, so ask once first. */
export async function listInputs(): Promise<InputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  let inputs = devices.filter((d) => d.kind === 'audioinput')
  if (inputs.length > 0 && inputs.every((d) => !d.label)) {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
    tmp.getTracks().forEach((t) => t.stop())
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  }
  return inputs
    .filter((d) => d.deviceId !== 'communications')
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${i + 1}`,
      virtual: isVirtualDevice(d.label)
    }))
}

/** A stream owned by someone else (e.g. a mixer bus) to analyse instead of a device */
export interface ExternalSource {
  stream: MediaStream
  label: string
}

export async function openInput(profile: AudioProfile, onEnded: () => void, external?: ExternalSource): Promise<OpenInput> {
  const processing = !profile.disableProcessing
  const constraints: MediaTrackConstraints = {
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    // Ask for many channels so consoles/interfaces expose their individual inputs
    channelCount: { ideal: typeof profile.channel === 'number' ? 32 : 2 }
  }
  if (profile.deviceId && profile.deviceId !== 'default') constraints.deviceId = { exact: profile.deviceId }
  if (profile.sampleRate) constraints.sampleRate = { ideal: profile.sampleRate }

  const stream = external?.stream ?? (await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false }))
  const track = stream.getAudioTracks()[0]
  const settings = track.getSettings()

  const contextOptions: AudioContextOptions = { latencyHint: profile.latency }
  if (profile.sampleRate && !external) contextOptions.sampleRate = profile.sampleRate
  const context = new AudioContext(contextOptions)
  const source = context.createMediaStreamSource(stream)
  const channelCount = settings.channelCount ?? source.channelCount ?? 1

  const gain = context.createGain()
  gain.gain.value = Math.pow(10, profile.gainDb / 20)

  const analyser = context.createAnalyser()
  analyser.fftSize = 2048
  analyser.smoothingTimeConstant = 0

  const spectrumAnalyser = context.createAnalyser()
  spectrumAnalyser.fftSize = 8192
  spectrumAnalyser.smoothingTimeConstant = 0.5
  spectrumAnalyser.minDecibels = -120
  spectrumAnalyser.maxDecibels = 0

  if (!external && typeof profile.channel === 'number' && channelCount > 1) {
    const splitter = context.createChannelSplitter(channelCount)
    source.connect(splitter)
    splitter.connect(gain, Math.min(profile.channel, channelCount - 1))
  } else {
    source.connect(gain)
  }
  gain.connect(analyser)
  gain.connect(spectrumAnalyser)

  const handleEnded = (): void => onEnded()
  track.addEventListener('ended', handleEnded)

  return {
    context,
    analyser,
    spectrumAnalyser,
    tap: gain,
    stream,
    channelCount,
    sampleRate: context.sampleRate,
    label: external?.label ?? track.label,
    close: () => {
      track.removeEventListener('ended', handleEnded)
      // An external stream belongs to its owner: only stop tracks we opened
      if (!external) stream.getTracks().forEach((t) => t.stop())
      context.close().catch(() => undefined)
    }
  }
}
