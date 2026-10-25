// In-memory takes (raw PCM is too big to persist) and loudness-matched playback.

export interface Take {
  pcm: Float32Array
  sampleRate: number
  rms: number
}

const takes = new Map<string, Take>()

export const takeStore = {
  get: (id: string): Take | undefined => takes.get(id),
  set: (id: string, t: Take): void => void takes.set(id, t),
  delete: (id: string): void => void takes.delete(id),
  has: (id: string): boolean => takes.has(id)
}

let ctx: AudioContext | null = null
let current: { stop: () => void; id: string } | null = null
const listeners = new Set<(id: string | null) => void>()

function notify(): void {
  listeners.forEach((l) => l(current?.id ?? null))
}

export function onPlaybackChange(l: (id: string | null) => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function stopPlayback(): void {
  current?.stop()
  current = null
  notify()
}

export function playTake(id: string, take: Take, gain: number): void {
  stopPlayback()
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  const buffer = ctx.createBuffer(1, take.pcm.length, take.sampleRate)
  buffer.copyToChannel(take.pcm as Float32Array<ArrayBuffer>, 0)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const g = ctx.createGain()
  g.gain.value = gain
  src.connect(g).connect(ctx.destination)
  src.onended = () => {
    if (current?.id === id) {
      current = null
      notify()
    }
  }
  src.start()
  current = {
    id,
    stop: () => {
      src.onended = null
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
    }
  }
  notify()
}
