import { highPass, highShelf, lowShelf, peaking, responseDb, type Biquad } from '../studio/dsp'

// Virtual mixing console model: input strips (one per mic/channel) routed to buses
// (physical outputs or internal buses for recording and analysis). Pure data + helpers;
// the Web Audio graph lives in core/audio/MixerEngine.ts.

export type InputMode = 'mix' | 'mono' | 'stereo'

export interface StripInput {
  /** null = system default input */
  deviceId: string | null
  mode: InputMode
  /** 0-based device channel for mono, left channel for stereo */
  left: number
  right: number
}

export type EqBandType = 'lowshelf' | 'peaking' | 'highshelf'

export interface EqBand {
  type: EqBandType
  freq: number
  gainDb: number
  /** Peaking only */
  q: number
}

export interface Strip {
  id: string
  name: string
  color: string
  input: StripInput
  /** Preamp/digital trim before processing */
  trimDb: number
  phaseInvert: boolean
  hpf: { on: boolean; hz: number }
  gate: { on: boolean; thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number }
  eq: { on: boolean; bands: EqBand[] }
  comp: { on: boolean; thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number; makeupDb: number }
  /** Channel peak limiter after the compressor */
  limiter: { on: boolean; ceilingDb: number }
  /** Pre-fader listen: sends this strip to the monitor output instead of the monitored bus */
  cue: boolean
  /** Narrow cuts against feedback (max MAX_NOTCHES) */
  notches: Notch[]
  /** Sidechain ducking: this strip drops while `sourceId` is active */
  duck: Duck
  /** Time alignment between mics, ms */
  delayMs: number
  faderDb: number
  /** −1 (left) … +1 (right) */
  pan: number
  mute: boolean
  solo: boolean
  /** Bus ids this strip feeds (post-fader) */
  sends: string[]
}

export interface Notch {
  hz: number
  gainDb: number
  q: number
}

export interface Duck {
  on: boolean
  /** Strip whose signal triggers the ducking (e.g. the voice) */
  sourceId: string | null
  /** Level the source must exceed, dBFS */
  thresholdDb: number
  /** How much this strip drops, dB (negative) */
  amountDb: number
  attackMs: number
  releaseMs: number
}

export type MidiTargetKind = 'stripFader' | 'stripMute' | 'stripSolo' | 'stripCue' | 'stripPan' | 'busFader' | 'busMute'

export interface MidiMapping {
  /** "cc:<channel>:<number>" or "note:<channel>:<number>" */
  key: string
  kind: MidiTargetKind
  /** Strip or bus id */
  id: string
}

export type BusKind = 'out' | 'internal'

export interface Bus {
  id: string
  /** Short label shown on the send buttons, e.g. "A1" */
  label: string
  name: string
  kind: BusKind
  /** Output device for 'out' buses; null = system default */
  deviceId: string | null
  faderDb: number
  mute: boolean
  mono: boolean
  /** Brickwall-style limiter at −1 dBFS */
  limiter: boolean
  /** Aux (C) buses: strips send before their fader (stage monitors), honouring mute only */
  pre?: boolean
  /** User-added bus (aux C), can be removed */
  custom?: boolean
}

export const MAX_AUX_BUSES = 4

/** Adds an aux bus C1, C2…: a physical output fed pre-fader, like a console's monitor sends */
export function addAuxBus(cfg: MixerConfig): MixerConfig {
  const aux = cfg.buses.filter((b) => b.custom)
  if (aux.length >= MAX_AUX_BUSES) return cfg
  let n = 1
  while (cfg.buses.some((b) => b.id === `C${n}`)) n++
  const bus: Bus = { id: `C${n}`, label: `C${n}`, name: `Monitor ${n}`, kind: 'out', deviceId: null, faderDb: 0, mute: false, mono: true, limiter: true, pre: true, custom: true }
  return { ...cfg, buses: [...cfg.buses, bus] }
}

/** Removes a user-added bus and every send/monitor/MIDI reference to it */
export function removeBus(cfg: MixerConfig, id: string): MixerConfig {
  const bus = cfg.buses.find((b) => b.id === id)
  if (!bus?.custom) return cfg
  const buses = cfg.buses.filter((b) => b.id !== id)
  return {
    ...cfg,
    buses,
    strips: cfg.strips.map((s) => ({ ...s, sends: s.sends.filter((x) => x !== id) })),
    midi: cfg.midi.filter((m) => m.id !== id),
    monitor: cfg.monitor.source === id ? { ...cfg.monitor, source: buses[0].id } : cfg.monitor
  }
}

/** Linear send level of a strip into a bus: pre-fader buses ignore the fader and solo, not mute */
export function sendGain(strip: Strip, bus: Pick<Bus, 'id' | 'pre'>): number {
  if (!strip.sends.includes(bus.id)) return 0
  return bus.pre && strip.mute ? 0 : 1
}

export interface MixerScene {
  id: string
  name: string
  strips: Strip[]
  buses: Bus[]
}

export interface MixerConfig {
  strips: Strip[]
  buses: Bus[]
  scenes: MixerScene[]
  /** Engine sample rate; null = device default */
  sampleRate: number | null
  midi: MidiMapping[]
  /** Where the strip meters read: after processing (pre-fader) or after the fader */
  meterPoint: MeterPoint
  monitor: Monitor
  userPresets: UserPreset[]
}

export type MeterPoint = 'pre' | 'post'

/** Headphone/cue output, like a console's phones section */
export interface Monitor {
  on: boolean
  /** Output device; null = system default */
  deviceId: string | null
  levelDb: number
  /** Bus heard when no strip has cue pressed */
  source: string
}

/** Processing a user saved to reuse on other strips */
export interface UserPreset {
  id: string
  name: string
  apply: ProcessingSnapshot
}

export type ProcessingSnapshot = Pick<Strip, 'hpf' | 'gate' | 'eq' | 'comp'> & Partial<Pick<Strip, 'limiter' | 'notches'>>

export const STRIP_COLORS = ['#ffb020', '#3fb6ff', '#5ee08a', '#ff6b8b', '#b48cff', '#ffe066', '#4dd6c9', '#ff9a5a']
export const MAX_STRIPS = 8
export const MAX_NOTCHES = 6
export const FADER_MIN = -60
export const FADER_MAX = 12

export function defaultEqBands(): EqBand[] {
  return [
    { type: 'lowshelf', freq: 100, gainDb: 0, q: 0.7 },
    { type: 'peaking', freq: 400, gainDb: 0, q: 1 },
    { type: 'peaking', freq: 2500, gainDb: 0, q: 1 },
    { type: 'highshelf', freq: 8000, gainDb: 0, q: 0.7 }
  ]
}

export function createStrip(index: number, overrides: Partial<Strip> = {}): Strip {
  return {
    id: `strip-${Math.random().toString(36).slice(2, 9)}`,
    name: `Entrada ${index + 1}`,
    color: STRIP_COLORS[index % STRIP_COLORS.length],
    input: { deviceId: null, mode: 'mix', left: 0, right: 1 },
    trimDb: 0,
    phaseInvert: false,
    hpf: { on: false, hz: 80 },
    gate: { on: false, thresholdDb: -50, rangeDb: -60, attackMs: 2, holdMs: 80, releaseMs: 150 },
    eq: { on: true, bands: defaultEqBands() },
    comp: { on: false, thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0 },
    limiter: { on: false, ceilingDb: -3 },
    cue: false,
    notches: [],
    duck: { on: false, sourceId: null, thresholdDb: -40, amountDb: -15, attackMs: 40, releaseMs: 500 },
    delayMs: 0,
    faderDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    // Internal bus only: never straight to the speakers (feedback)
    sends: ['B1'],
    ...overrides
  }
}

export function defaultBuses(): Bus[] {
  return [
    { id: 'A1', label: 'A1', name: 'Salida principal', kind: 'out', deviceId: null, faderDb: 0, mute: false, mono: false, limiter: true },
    { id: 'A2', label: 'A2', name: 'Salida 2', kind: 'out', deviceId: null, faderDb: 0, mute: true, mono: false, limiter: true },
    { id: 'B1', label: 'B1', name: 'Grabación', kind: 'internal', deviceId: null, faderDb: 0, mute: false, mono: false, limiter: false },
    { id: 'B2', label: 'B2', name: 'Bus 2', kind: 'internal', deviceId: null, faderDb: 0, mute: false, mono: false, limiter: false }
  ]
}

export function defaultMixer(): MixerConfig {
  return {
    strips: [createStrip(0, { name: 'Micro 1' })],
    buses: defaultBuses(),
    scenes: [],
    sampleRate: 48000,
    midi: [],
    meterPoint: 'post',
    // Off by default: monitoring to speakers would feed back
    monitor: { on: false, deviceId: null, levelDb: -6, source: 'A1' },
    userPresets: []
  }
}

/** Fills fields added in newer versions so old saves keep working */
export function mergeMixer(saved: Partial<MixerConfig> | null | undefined): MixerConfig {
  const d = defaultMixer()
  if (!saved) return d
  const buses = Array.isArray(saved.buses) && saved.buses.length ? saved.buses.map((b) => ({ ...d.buses[0], ...b })) : d.buses
  const strips = Array.isArray(saved.strips) ? saved.strips.map((s, i) => normalizeStrip(s, i, buses)) : d.strips
  const monitor = { ...d.monitor, ...saved.monitor }
  if (!buses.some((b) => b.id === monitor.source)) monitor.source = buses[0].id
  return {
    ...d,
    ...saved,
    strips,
    buses,
    scenes: Array.isArray(saved.scenes) ? saved.scenes : [],
    midi: Array.isArray(saved.midi) ? saved.midi : [],
    meterPoint: saved.meterPoint === 'pre' ? 'pre' : 'post',
    monitor,
    userPresets: Array.isArray(saved.userPresets) ? saved.userPresets : []
  }
}

function normalizeStrip(s: Partial<Strip>, i: number, buses: Bus[]): Strip {
  const base = createStrip(i)
  const bands = s.eq?.bands?.length === 4 ? s.eq.bands : base.eq.bands
  return {
    ...base,
    ...s,
    input: { ...base.input, ...s.input },
    hpf: { ...base.hpf, ...s.hpf },
    gate: { ...base.gate, ...s.gate },
    eq: { on: s.eq?.on ?? base.eq.on, bands },
    comp: { ...base.comp, ...s.comp },
    limiter: { ...base.limiter, ...s.limiter },
    notches: Array.isArray(s.notches) ? s.notches.slice(0, MAX_NOTCHES) : [],
    duck: { ...base.duck, ...s.duck },
    sends: (s.sends ?? base.sends).filter((id) => buses.some((b) => b.id === id))
  }
}

// ---- Gain helpers

export function dbToGain(db: number): number {
  return db <= FADER_MIN ? 0 : Math.pow(10, db / 20)
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g)
}

/** Any strip soloed → every non-soloed strip is silent */
export function isAudible(strip: Strip, all: Strip[]): boolean {
  if (strip.mute) return false
  const anySolo = all.some((s) => s.solo)
  return !anySolo || strip.solo
}

/** Linear fader gain after mute/solo */
export function stripOutputGain(strip: Strip, all: Strip[]): number {
  return isAudible(strip, all) ? dbToGain(strip.faderDb) : 0
}

/** Constant-power pan law: −3 dB in the centre, as StereoPannerNode on a mono source */
export function panGains(pan: number): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan))
  const x = ((p + 1) / 2) * (Math.PI / 2)
  return { left: Math.cos(x), right: Math.sin(x) }
}

/** Fader position 0..1 with more resolution near unity (like a real console fader) */
export function faderToPos(db: number): number {
  const d = Math.max(FADER_MIN, Math.min(FADER_MAX, db))
  if (d >= -10) return 0.5 + ((d + 10) / (FADER_MAX + 10)) * 0.5
  return ((d - FADER_MIN) / (-10 - FADER_MIN)) * 0.5
}

export function posToFader(pos: number): number {
  const p = Math.max(0, Math.min(1, pos))
  const db = p >= 0.5 ? -10 + ((p - 0.5) / 0.5) * (FADER_MAX + 10) : FADER_MIN + (p / 0.5) * (-10 - FADER_MIN)
  return Math.round(db * 10) / 10
}

/**
 * Trim that brings the loudest measured input peak to `targetDb` (−12 dBFS leaves headroom
 * for shouts). null when nothing was heard. Clamped to the trim control's range.
 */
export function autoTrim(currentTrimDb: number, maxPeakDb: number, targetDb = -12): number | null {
  if (maxPeakDb <= -70) return null
  return Math.round(Math.max(-24, Math.min(36, currentTrimDb + targetDb - maxPeakDb)) * 2) / 2
}

// ---- Processing curves (for drawing)

export function eqSections(strip: Pick<Strip, 'eq' | 'hpf'> & { notches?: Notch[] }, sampleRate: number): Biquad[] {
  const out: Biquad[] = []
  if (strip.hpf.on) out.push(highPass(strip.hpf.hz, sampleRate))
  for (const n of strip.notches ?? []) out.push(peaking(n.hz, n.gainDb, n.q, sampleRate))
  if (strip.eq.on) {
    for (const b of strip.eq.bands) {
      if (b.type === 'lowshelf') out.push(lowShelf(b.freq, b.gainDb, sampleRate))
      else if (b.type === 'highshelf') out.push(highShelf(b.freq, b.gainDb, sampleRate))
      else out.push(peaking(b.freq, b.gainDb, b.q, sampleRate))
    }
  }
  return out
}

/** Combined HPF + EQ magnitude response at each frequency, dB */
export function eqResponse(strip: Pick<Strip, 'eq' | 'hpf'> & { notches?: Notch[] }, freqs: number[], sampleRate = 48000): number[] {
  const sections = eqSections(strip, sampleRate)
  return freqs.map((f) => (sections.length ? Math.round(responseDb(sections, f, sampleRate) * 100) / 100 : 0))
}

/** Log-spaced frequencies for curve drawing */
export function logFreqs(n = 120, from = 20, to = 20000): number[] {
  return Array.from({ length: n }, (_, i) => from * Math.pow(to / from, i / (n - 1)))
}

// ---- Ducking

/**
 * One step of the ducking envelope: moves the target gain toward `amountDb` while the source
 * is above threshold, back to 0 dB otherwise, with attack/release time constants.
 */
export function duckStep(currentDb: number, sourceDb: number, duck: Duck, dtMs: number): number {
  const target = sourceDb > duck.thresholdDb ? duck.amountDb : 0
  const tau = target < currentDb ? duck.attackMs : duck.releaseMs
  const k = 1 - Math.exp(-dtMs / Math.max(1, tau))
  const next = currentDb + (target - currentDb) * k
  // Snap once inaudibly close so the gain settles exactly
  return Math.abs(next - target) < 0.05 ? target : next
}

// ---- MIDI control

export interface MidiMessage {
  type: 'cc' | 'noteon' | 'noteoff'
  channel: number
  number: number
  value: number
}

/** Decodes a raw MIDI message (status, data1, data2); null for anything we don't map */
export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  if (data.length < 3) return null
  const status = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  if (status === 0xb0) return { type: 'cc', channel, number: data[1], value: data[2] }
  // Note-on with velocity 0 is a note-off by convention
  if (status === 0x90) return { type: data[2] > 0 ? 'noteon' : 'noteoff', channel, number: data[1], value: data[2] }
  if (status === 0x80) return { type: 'noteoff', channel, number: data[1], value: 0 }
  return null
}

export function midiKey(m: MidiMessage): string {
  return `${m.type === 'cc' ? 'cc' : 'note'}:${m.channel}:${m.number}`
}

export function describeMidiKey(key: string): string {
  const [type, ch, num] = key.split(':')
  return type === 'cc' ? `CC ${num} · canal ${ch}` : `Nota ${num} · canal ${ch}`
}

/** Applies a MIDI message to the mixer: continuous controls set values, buttons toggle */
export function applyMidi(cfg: MixerConfig, m: MidiMessage): MixerConfig {
  const key = midiKey(m)
  const maps = cfg.midi.filter((x) => x.key === key)
  if (maps.length === 0 || m.type === 'noteoff') return cfg
  // Buttons toggle on press: note-on, or a CC jumping to its top half
  const press = m.type === 'noteon' || m.value >= 64
  let next = cfg
  for (const map of maps) {
    const v = m.value / 127
    const strip = (fn: (s: Strip) => Strip): void => {
      next = { ...next, strips: next.strips.map((s) => (s.id === map.id ? fn(s) : s)) }
    }
    const bus = (fn: (b: Bus) => Bus): void => {
      next = { ...next, buses: next.buses.map((b) => (b.id === map.id ? fn(b) : b)) }
    }
    if (map.kind === 'stripFader') strip((s) => ({ ...s, faderDb: posToFader(v) }))
    else if (map.kind === 'stripPan') strip((s) => ({ ...s, pan: Math.round((v * 2 - 1) * 50) / 50 }))
    else if (map.kind === 'busFader') bus((b) => ({ ...b, faderDb: posToFader(v) }))
    else if (press && map.kind === 'stripMute') strip((s) => ({ ...s, mute: !s.mute }))
    else if (press && map.kind === 'stripSolo') strip((s) => ({ ...s, solo: !s.solo }))
    else if (press && map.kind === 'stripCue') strip((s) => ({ ...s, cue: !s.cue }))
    else if (press && map.kind === 'busMute') bus((b) => ({ ...b, mute: !b.mute }))
  }
  return next
}

/** Replaces any mapping of the same target (or the same control) with the new one */
export function learnMidi(cfg: MixerConfig, key: string, kind: MidiTargetKind, id: string): MixerConfig {
  const midi = cfg.midi.filter((x) => !(x.kind === kind && x.id === id) && x.key !== key)
  return { ...cfg, midi: [...midi, { key, kind, id }] }
}

// ---- Channel presets

export interface StripPreset {
  id: string
  name: string
  apply: ProcessingSnapshot
}

const band = (type: EqBand['type'], freq: number, gainDb: number, q = 1): EqBand => ({ type, freq, gainDb, q })
const gateOff = (): Strip['gate'] => ({ on: false, thresholdDb: -50, rangeDb: -60, attackMs: 2, holdMs: 80, releaseMs: 150 })
const compOff = (): Strip['comp'] => ({ on: false, thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0 })

export const STRIP_PRESETS: StripPreset[] = [
  {
    id: 'clean',
    name: 'Limpio (sin procesar)',
    apply: { hpf: { on: false, hz: 80 }, gate: gateOff(), eq: { on: true, bands: defaultEqBands() }, comp: compOff() }
  },
  {
    id: 'speech',
    name: 'Voz hablada',
    apply: {
      hpf: { on: true, hz: 90 },
      gate: { on: true, thresholdDb: -52, rangeDb: -20, attackMs: 2, holdMs: 120, releaseMs: 200 },
      eq: { on: true, bands: [band('lowshelf', 150, -2), band('peaking', 350, -2.5, 1.2), band('peaking', 3500, 3, 0.9), band('highshelf', 10000, 2)] },
      comp: { on: true, thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 120, makeupDb: 4 }
    }
  },
  {
    id: 'podcast',
    name: 'Podcast / radio',
    apply: {
      hpf: { on: true, hz: 80 },
      gate: { on: true, thresholdDb: -48, rangeDb: -25, attackMs: 1, holdMs: 150, releaseMs: 250 },
      eq: { on: true, bands: [band('lowshelf', 120, 2), band('peaking', 400, -3, 1), band('peaking', 4000, 3.5, 1), band('highshelf', 12000, 2.5)] },
      comp: { on: true, thresholdDb: -24, ratio: 4, kneeDb: 4, attackMs: 5, releaseMs: 100, makeupDb: 7 }
    }
  },
  {
    id: 'singing',
    name: 'Voz cantada',
    apply: {
      hpf: { on: true, hz: 100 },
      gate: gateOff(),
      eq: { on: true, bands: [band('lowshelf', 120, -1.5), band('peaking', 300, -2, 1.4), band('peaking', 5000, 2.5, 0.8), band('highshelf', 12000, 3)] },
      comp: { on: true, thresholdDb: -18, ratio: 2.5, kneeDb: 10, attackMs: 15, releaseMs: 200, makeupDb: 3 }
    }
  },
  {
    id: 'acoustic',
    name: 'Instrumento acústico',
    apply: {
      hpf: { on: true, hz: 60 },
      gate: gateOff(),
      eq: { on: true, bands: [band('lowshelf', 100, -1), band('peaking', 250, -2, 1), band('peaking', 3000, 1.5, 0.8), band('highshelf', 9000, 2)] },
      comp: { on: true, thresholdDb: -22, ratio: 2, kneeDb: 10, attackMs: 25, releaseMs: 250, makeupDb: 2 }
    }
  },
  {
    id: 'music',
    name: 'Música de fondo',
    apply: {
      hpf: { on: false, hz: 40 },
      gate: gateOff(),
      // A dip where the voice lives leaves room for whoever is talking over it
      eq: { on: true, bands: [band('lowshelf', 100, 0), band('peaking', 2500, -3, 0.7), band('peaking', 4000, 0), band('highshelf', 8000, 0)] },
      comp: compOff()
    }
  }
]

/** Applies a preset's processing (built-in or user); routing, levels and name stay as they were */
export function applyPreset(strip: Strip, presetId: string, user: UserPreset[] = []): Strip {
  const p = STRIP_PRESETS.find((x) => x.id === presetId) ?? user.find((x) => x.id === presetId)
  if (!p) return strip
  return applyProcessing(strip, p.apply)
}

export function applyProcessing(strip: Strip, apply: ProcessingSnapshot): Strip {
  return { ...strip, ...structuredCloneSafe(apply) }
}

/** The strip's processing, detached from it */
export function processingOf(strip: Strip): ProcessingSnapshot {
  return structuredCloneSafe({ hpf: strip.hpf, gate: strip.gate, eq: strip.eq, comp: strip.comp, limiter: strip.limiter, notches: strip.notches })
}

/** Saves the strip's processing as a user preset; the same name overwrites */
export function saveUserPreset(cfg: MixerConfig, strip: Strip, name: string, id = `preset-${Date.now().toString(36)}`): MixerConfig {
  const n = name.trim() || strip.name
  const existing = cfg.userPresets.find((p) => p.name.toLowerCase() === n.toLowerCase())
  const preset: UserPreset = { id: existing?.id ?? id, name: n, apply: processingOf(strip) }
  return { ...cfg, userPresets: existing ? cfg.userPresets.map((p) => (p.id === existing.id ? preset : p)) : [...cfg.userPresets, preset] }
}

// ---- Monitor / cue

/** What the monitor output plays: the cued strips (pre-fader) if any, otherwise the source bus */
export function monitorFeed(cfg: Pick<MixerConfig, 'strips' | 'monitor'>): { kind: 'cue'; strips: string[] } | { kind: 'bus'; bus: string } {
  const cued = cfg.strips.filter((s) => s.cue).map((s) => s.id)
  return cued.length ? { kind: 'cue', strips: cued } : { kind: 'bus', bus: cfg.monitor.source }
}

// ---- Gain staging

export type LevelStatus = 'silence' | 'low' | 'ok' | 'hot' | 'clip'

/** Classifies a peak level (dBFS) the way a console's LEDs would */
export function levelStatus(peakDb: number): LevelStatus {
  if (peakDb > -1) return 'clip'
  if (peakDb > -6) return 'hot'
  if (peakDb > -30) return 'ok'
  if (peakDb > -60) return 'low'
  return 'silence'
}

/**
 * Advice from the held input peak (post-trim) and the held pre-fader peak (after processing).
 * The input stage is the one that matters: digital gain later can't fix a noisy or clipped input.
 */
export function gainAdvice(inPeakDb: number, preFaderDb: number): { status: LevelStatus; message: string } {
  const st = levelStatus(inPeakDb)
  if (st === 'clip') return { status: 'clip', message: 'La entrada satura: baja el trim o la ganancia del preamplificador.' }
  if (st === 'silence') return { status: 'silence', message: 'No llega señal: revisa el cable, el canal o el phantom (+48 V).' }
  if (st === 'low') return { status: 'low', message: 'Entrada baja: sube el preamplificador hasta que los picos lleguen a −18…−12 dBFS.' }
  if (levelStatus(preFaderDb) === 'clip') return { status: 'clip', message: 'El procesamiento satura (EQ o compensación del compresor): baja la ganancia de compensación.' }
  if (st === 'hot') return { status: 'hot', message: 'Entrada alta: poco margen para un grito. Baja 3–6 dB.' }
  return { status: 'ok', message: 'Ganancia correcta: buen margen y lejos del ruido.' }
}

// ---- Routing checks

export interface RoutingWarning {
  stripId: string
  message: string
}

/** Things a sound engineer would flag before going live */
export function routingWarnings(cfg: Pick<MixerConfig, 'strips' | 'buses'> & Partial<Pick<MixerConfig, 'monitor'>>): RoutingWarning[] {
  const warnings: RoutingWarning[] = []
  for (const s of cfg.strips) {
    const outs = s.sends.map((id) => cfg.buses.find((b) => b.id === id)).filter((b): b is Bus => !!b && b.kind === 'out' && !b.mute)
    if (outs.length > 0) warnings.push({ stripId: s.id, message: `${s.name} suena por ${outs.map((b) => b.label).join(', ')}: usa auriculares o se acoplará con altavoces.` })
    if (s.sends.length === 0) warnings.push({ stripId: s.id, message: `${s.name} no está enviada a ningún bus.` })
    if (s.duck.on && (!s.duck.sourceId || !cfg.strips.some((x) => x.id === s.duck.sourceId && x.id !== s.id)))
      warnings.push({ stripId: s.id, message: `${s.name}: el ducking no tiene una entrada que lo active.` })
    if (s.cue && !cfg.monitor?.on) warnings.push({ stripId: s.id, message: `${s.name} está en CUE pero el monitor está apagado.` })
    if (s.trimDb + s.faderDb > 24) warnings.push({ stripId: s.id, message: `${s.name} tiene mucha ganancia digital: sube mejor el preamplificador.` })
  }
  return warnings
}

// ---- Scenes

export function saveScene(cfg: MixerConfig, name: string, id = `scene-${Date.now().toString(36)}`): MixerConfig {
  const scene: MixerScene = { id, name: name.trim() || `Escena ${cfg.scenes.length + 1}`, strips: structuredCloneSafe(cfg.strips), buses: structuredCloneSafe(cfg.buses) }
  return { ...cfg, scenes: [...cfg.scenes, scene] }
}

export function loadScene(cfg: MixerConfig, sceneId: string): MixerConfig {
  const scene = cfg.scenes.find((s) => s.id === sceneId)
  if (!scene) return cfg
  const merged = mergeMixer({ strips: scene.strips, buses: scene.buses })
  return { ...cfg, strips: merged.strips, buses: merged.buses }
}

const MIXER_APP = 'gritometro-mezclador'

export function serializeMixer(cfg: MixerConfig): string {
  const { strips, buses, scenes, midi, meterPoint, monitor, userPresets } = cfg
  return JSON.stringify({ app: MIXER_APP, version: 1, strips, buses, scenes, midi, meterPoint, monitor, userPresets }, null, 2)
}

export function parseMixer(text: string): Pick<MixerConfig, 'strips' | 'buses' | 'scenes' | 'midi' | 'meterPoint' | 'monitor' | 'userPresets'> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  const r = raw as { app?: string; strips?: unknown; buses?: unknown; scenes?: unknown }
  if (!r || r.app !== MIXER_APP || !Array.isArray(r.strips)) throw new Error('No es una configuración del mezclador.')
  const merged = mergeMixer(r as Partial<MixerConfig>)
  const { buses, scenes, midi, meterPoint, monitor, userPresets } = merged
  return { strips: merged.strips.slice(0, MAX_STRIPS), buses, scenes, midi, meterPoint, monitor, userPresets }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
