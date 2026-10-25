// In-memory takes (raw PCM is too big to persist) and loudness-matched playback.
// One playback at a time: a single take, or a synced group for instant A/B switching.

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

/** AudioContext.setSinkId isn't in the TS DOM lib yet */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let ctx: SinkContext | null = null
let sinkId: string | null = null

function context(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext() as SinkContext
    if (sinkId) ctx.setSinkId?.(sinkId).catch(() => undefined)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

/** Output device for take playback (null = system default) */
export function setPlaybackDevice(id: string | null): void {
  sinkId = id
  ctx?.setSinkId?.(id ?? '').catch(() => undefined)
}

interface Current {
  /** Id shown as playing (the active one in a group) */
  id: string
  stop: () => void
  startedAt: number
  offset: number
  duration: number
  loop: boolean
  /** Group only: gain nodes per id */
  gains?: Map<string, { node: GainNode; level: number }>
}

let current: Current | null = null
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

function source(c: AudioContext, take: Take, loop: boolean): AudioBufferSourceNode {
  const buffer = c.createBuffer(1, take.pcm.length, take.sampleRate)
  buffer.copyToChannel(take.pcm as Float32Array<ArrayBuffer>, 0)
  const src = c.createBufferSource()
  src.buffer = buffer
  src.loop = loop
  return src
}

function stopAll(srcs: AudioBufferSourceNode[]): void {
  for (const s of srcs) {
    s.onended = null
    try {
      s.stop()
    } catch {
      /* already stopped */
    }
  }
}

export function playTake(id: string, take: Take, gain: number, opts: { offset?: number; loop?: boolean } = {}): void {
  stopPlayback()
  const c = context()
  const loop = opts.loop ?? false
  const duration = take.pcm.length / take.sampleRate
  const offset = Math.min(Math.max(0, opts.offset ?? 0), Math.max(0, duration - 0.01))
  const src = source(c, take, loop)
  const g = c.createGain()
  g.gain.value = gain
  src.connect(g).connect(c.destination)
  src.onended = () => {
    if (current?.id === id) {
      current = null
      notify()
    }
  }
  src.start(0, offset)
  current = { id, stop: () => stopAll([src]), startedAt: c.currentTime, offset, duration, loop }
  notify()
}

/**
 * Starts several takes in sync (looping) with only `activeId` audible, so switching
 * between mics is instant and lands on the same word.
 */
export function playGroup(items: { id: string; take: Take; gain: number }[], activeId: string): void {
  stopPlayback()
  if (items.length === 0) return
  const c = context()
  const when = c.currentTime + 0.05
  const gains = new Map<string, { node: GainNode; level: number }>()
  const srcs: AudioBufferSourceNode[] = []
  // Loop over the shortest take so every mic restarts together
  const duration = Math.min(...items.map((i) => i.take.pcm.length / i.take.sampleRate))
  for (const it of items) {
    const src = source(c, it.take, true)
    src.loopEnd = duration
    const g = c.createGain()
    g.gain.value = it.id === activeId ? it.gain : 0
    src.connect(g).connect(c.destination)
    src.start(when)
    srcs.push(src)
    gains.set(it.id, { node: g, level: it.gain })
  }
  current = { id: activeId, stop: () => stopAll(srcs), startedAt: when, offset: 0, duration, loop: true, gains }
  notify()
}

/** Switches the audible take of a running group (short crossfade, no click) */
export function switchGroup(id: string): boolean {
  if (!current?.gains?.has(id) || !ctx) return false
  const t = ctx.currentTime
  current.gains.forEach((g, gid) => g.node.gain.setTargetAtTime(gid === id ? g.level : 0, t, 0.008))
  current = { ...current, id }
  notify()
  return true
}

export function isGroupPlaying(): boolean {
  return !!current?.gains
}

/** Playback position in seconds of the current take, or null */
export function playbackPosition(): { id: string; seconds: number; duration: number } | null {
  if (!current || !ctx) return null
  let s = current.offset + Math.max(0, ctx.currentTime - current.startedAt)
  if (current.loop && current.duration > 0) s %= current.duration
  return { id: current.id, seconds: Math.min(s, current.duration), duration: current.duration }
}
