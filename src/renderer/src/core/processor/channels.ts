import type { ProcessingChain, ProcessorConfig } from './processor'
import { chainOf, defaultProcessor } from './processor'

// Per-channel setups for the mic processor. Every input channel of every interface keeps its
// own processing; only one is loaded in the processor at a time. Switching channel stores the
// one being edited exactly as it was and brings back the saved setup of the new one.
// Channels marked "live" keep being processed in parallel (core/audio/MultiProcessor.ts) while
// another one is loaded, each to its own output.

export interface ChannelSetup {
  /** User name for the channel, e.g. "Micro del presentador" ('' = none) */
  name: string
  note: string
  chain: ProcessingChain
  inputGainDb: number
  outputGainDb: number
  phaseInvert: boolean
  eqPosition: ProcessorConfig['eqPosition']
  /** Processed all the time, in parallel with the loaded channel */
  live: boolean
  /** Own output device ('' = system default), null = the processor's output */
  outputId: string | null
  /** ms since epoch of the last time it was stored */
  updatedAt: number
}

export type ChannelInput = ProcessorConfig['input']

/** Stable key for a device channel; −1 = all channels mixed */
export function channelKey(input: ChannelInput): string {
  return `${input.deviceId || 'default'}#${input.channel}`
}

export function parseChannelKey(key: string): ChannelInput {
  const i = key.lastIndexOf('#')
  const id = key.slice(0, i)
  return { deviceId: id === 'default' ? null : id, channel: Number(key.slice(i + 1)) }
}

/** What a channel setup captures from the processor */
export function snapshotChannel(cfg: ProcessorConfig, previous?: Partial<ChannelSetup>, now = Date.now()): ChannelSetup {
  return {
    name: previous?.name ?? '',
    note: previous?.note ?? '',
    chain: chainOf(cfg),
    inputGainDb: cfg.inputGainDb,
    outputGainDb: cfg.outputGainDb,
    phaseInvert: cfg.phaseInvert,
    eqPosition: cfg.eqPosition,
    live: previous?.live ?? false,
    outputId: previous?.outputId ?? null,
    updatedAt: now
  }
}

/** A fresh channel: clean processing (only protection), unity gains */
export function blankChannel(now = Date.now()): ChannelSetup {
  return snapshotChannel(defaultProcessor(), undefined, now)
}

function restore(cfg: ProcessorConfig, s: ChannelSetup): ProcessorConfig {
  const chain = JSON.parse(JSON.stringify(s.chain)) as ProcessingChain
  return { ...cfg, ...chain, inputGainDb: s.inputGainDb, outputGainDb: s.outputGainDb, phaseInvert: s.phaseInvert, eqPosition: s.eqPosition }
}

/**
 * Moves the processor to another input channel: the current channel is stored as it is now,
 * the target gets its saved setup back (or a clean one the first time). Output, monitor,
 * presets and everything that isn't per-channel stay as they are.
 */
export function switchChannel(cfg: ProcessorConfig, input: ChannelInput, now = Date.now()): ProcessorConfig {
  const from = channelKey(cfg.input)
  const to = channelKey(input)
  if (from === to) return { ...cfg, input }
  const current = snapshotChannel(cfg, cfg.channels[from], now)
  // A channel that was never touched isn't worth remembering
  const channels = cfg.channels[from] || !isBlank(current) ? { ...cfg.channels, [from]: current } : { ...cfg.channels }
  const target = channels[to] ?? { ...blankChannel(now), name: '' }
  return { ...restore(cfg, target), input, channels }
}

/** True when a setup is exactly the clean default (unnamed, unprocessed, unity gains) */
export function isBlank(s: ChannelSetup): boolean {
  const b = blankChannel(0)
  return !s.name && !s.note && !s.live && s.outputId === null && s.inputGainDb === 0 && s.outputGainDb === 0 && !s.phaseInvert && s.eqPosition === b.eqPosition && JSON.stringify(s.chain) === JSON.stringify(b.chain)
}

/** Stores the loaded channel without moving (e.g. before closing), keeping its name/note */
export function storeCurrent(cfg: ProcessorConfig, now = Date.now()): ProcessorConfig {
  const key = channelKey(cfg.input)
  return { ...cfg, channels: { ...cfg.channels, [key]: snapshotChannel(cfg, cfg.channels[key], now) } }
}

export type ChannelInfo = Partial<Pick<ChannelSetup, 'name' | 'note' | 'live' | 'outputId'>>

/** Renames / annotates / routes a channel (stored even if it was never loaded) */
export function setChannelInfo(cfg: ProcessorConfig, key: string, info: ChannelInfo): ProcessorConfig {
  const loaded = channelKey(cfg.input) === key
  const base = cfg.channels[key] ?? (loaded ? snapshotChannel(cfg) : blankChannel())
  return { ...cfg, channels: { ...cfg.channels, [key]: { ...base, ...info } } }
}

/** Copies the processing of one channel onto another; if the target is loaded, it applies at once */
export function copyChannel(cfg: ProcessorConfig, fromKey: string, toKey: string, now = Date.now()): ProcessorConfig {
  const loadedKey = channelKey(cfg.input)
  const src = fromKey === loadedKey ? snapshotChannel(cfg, cfg.channels[fromKey], now) : cfg.channels[fromKey]
  if (!src || fromKey === toKey) return cfg
  const prev = cfg.channels[toKey]
  const copy: ChannelSetup = { ...JSON.parse(JSON.stringify(src)), ...keepInfo(prev), updatedAt: now }
  const next = { ...cfg, channels: { ...cfg.channels, [toKey]: copy } }
  return toKey === loadedKey ? restore(next, copy) : next
}

/** What stays with a channel when its processing is replaced */
function keepInfo(prev: ChannelSetup | undefined): Pick<ChannelSetup, 'name' | 'note' | 'live' | 'outputId'> {
  return { name: prev?.name ?? '', note: prev?.note ?? '', live: prev?.live ?? false, outputId: prev?.outputId ?? null }
}

/** Back to clean processing; name, note and routing stay */
export function resetChannel(cfg: ProcessorConfig, key: string, now = Date.now()): ProcessorConfig {
  const prev = cfg.channels[key]
  const blank = { ...blankChannel(now), ...keepInfo(prev) }
  const next = { ...cfg, channels: { ...cfg.channels, [key]: blank } }
  return channelKey(cfg.input) === key ? restore(next, blank) : next
}

export function forgetChannel(cfg: ProcessorConfig, key: string): ProcessorConfig {
  const channels = { ...cfg.channels }
  delete channels[key]
  return { ...cfg, channels }
}

/** The setup to show for a channel: live values when it is the loaded one */
export function channelView(cfg: ProcessorConfig, key: string): ChannelSetup | null {
  if (channelKey(cfg.input) === key) return snapshotChannel(cfg, cfg.channels[key])
  return cfg.channels[key] ?? null
}

// ---- Routing and parallel processing

/** Output device of the loaded channel: its own one, or the processor's */
export function loadedOutput(cfg: ProcessorConfig): string | null {
  const own = cfg.channels[channelKey(cfg.input)]?.outputId
  return own ?? cfg.output.deviceId
}

/** Picks the output for the loaded channel: into its own routing when it has one */
export function setLoadedOutput(cfg: ProcessorConfig, deviceId: string | null): ProcessorConfig {
  const key = channelKey(cfg.input)
  if ((cfg.channels[key]?.outputId ?? null) !== null) return setChannelInfo(cfg, key, { outputId: deviceId ?? '' })
  return { ...cfg, output: { ...cfg.output, deviceId } }
}

/** What the main (editing) engine runs: the processor as it is, with the channel's own output */
export function mainConfig(cfg: ProcessorConfig): ProcessorConfig {
  const out = loadedOutput(cfg)
  return out === cfg.output.deviceId ? cfg : { ...cfg, output: { ...cfg.output, deviceId: out } }
}

/** Channels processed in parallel right now: marked live and not the one being edited */
export function liveChannels(cfg: ProcessorConfig): string[] {
  const loaded = channelKey(cfg.input)
  return Object.keys(cfg.channels).filter((k) => k !== loaded && cfg.channels[k].live)
}

/**
 * The full processor config a parallel channel runs: its saved processing on its own input,
 * to its own output (or the processor's). No headphone monitor and no bypass (those belong to
 * the channel being edited); the output mute silences every channel.
 */
export function channelConfig(cfg: ProcessorConfig, key: string): ProcessorConfig {
  const s = cfg.channels[key] ?? blankChannel(0)
  return {
    ...restore(cfg, s),
    input: parseChannelKey(key),
    output: { deviceId: s.outputId ?? cfg.output.deviceId, mute: cfg.output.mute },
    monitor: { ...cfg.monitor, on: false },
    bypass: false
  }
}

/** Short list of the active modules, e.g. ["Ruido", "Puerta", "EQ 5 bandas", "Comp 1", "Limitador"] */
export function chainSummary(s: Pick<ChannelSetup, 'chain'>): string[] {
  const c = s.chain
  const out: string[] = []
  if (c.noise.on) out.push('Ruido')
  if (c.gate.on) out.push(c.gate.mode === 'gate' ? 'Puerta' : 'Expansor')
  const bands = c.eq.on ? c.eq.bands.filter((b) => b.on && (b.gainDb !== 0 || b.type === 'highpass' || b.type === 'lowpass' || b.type === 'notch')).length : 0
  if (bands) out.push(`EQ ${bands} ${bands === 1 ? 'banda' : 'bandas'}`)
  if (c.deesser.on) out.push('De-esser')
  if (c.comp1.on) out.push('Comp 1')
  if (c.comp2.on) out.push('Comp 2')
  if (c.saturation.on) out.push('Saturador')
  if (c.limiter.on) out.push('Limitador')
  return out
}

// ---- Signal detection for the channel grid

export interface Activity {
  signal: boolean
  clip: boolean
  /** Highest peak in the hold window, dBFS */
  holdDb: number
}

/**
 * Per-channel activity: "signal" when the RMS stays above `thresholdDb` for a moment (so a
 * click doesn't count), held for `holdMs` after it stops; clip held the same way.
 */
export class ActivityTracker {
  private above = 0
  private signalLeft = 0
  private clipLeft = 0
  private hold = -100
  private holdAge = 0

  constructor(private thresholdDb = -50, private holdMs = 1500) {}

  update(rmsDb: number, peakDb: number, dtMs: number): Activity {
    this.above = rmsDb > this.thresholdDb ? this.above + dtMs : 0
    if (this.above >= 150) this.signalLeft = this.holdMs
    else this.signalLeft = Math.max(0, this.signalLeft - dtMs)
    if (peakDb > -0.5) this.clipLeft = 2000
    else this.clipLeft = Math.max(0, this.clipLeft - dtMs)
    this.holdAge += dtMs
    if (peakDb > this.hold || this.holdAge > this.holdMs) {
      this.hold = peakDb
      this.holdAge = 0
    }
    return { signal: this.signalLeft > 0, clip: this.clipLeft > 0, holdDb: this.hold }
  }
}
