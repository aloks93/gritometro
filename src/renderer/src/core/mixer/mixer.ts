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
}

export const STRIP_COLORS = ['#ffb020', '#3fb6ff', '#5ee08a', '#ff6b8b', '#b48cff', '#ffe066', '#4dd6c9', '#ff9a5a']
export const MAX_STRIPS = 8
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
  return { strips: [createStrip(0, { name: 'Micro 1' })], buses: defaultBuses(), scenes: [], sampleRate: 48000 }
}

/** Fills fields added in newer versions so old saves keep working */
export function mergeMixer(saved: Partial<MixerConfig> | null | undefined): MixerConfig {
  const d = defaultMixer()
  if (!saved) return d
  const buses = Array.isArray(saved.buses) && saved.buses.length ? saved.buses.map((b) => ({ ...d.buses[0], ...b })) : d.buses
  const strips = Array.isArray(saved.strips) ? saved.strips.map((s, i) => normalizeStrip(s, i, buses)) : d.strips
  return { ...d, ...saved, strips, buses, scenes: Array.isArray(saved.scenes) ? saved.scenes : [] }
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

export function eqSections(strip: Pick<Strip, 'eq' | 'hpf'>, sampleRate: number): Biquad[] {
  const out: Biquad[] = []
  if (strip.hpf.on) out.push(highPass(strip.hpf.hz, sampleRate))
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
export function eqResponse(strip: Pick<Strip, 'eq' | 'hpf'>, freqs: number[], sampleRate = 48000): number[] {
  const sections = eqSections(strip, sampleRate)
  return freqs.map((f) => (sections.length ? Math.round(responseDb(sections, f, sampleRate) * 100) / 100 : 0))
}

/** Log-spaced frequencies for curve drawing */
export function logFreqs(n = 120, from = 20, to = 20000): number[] {
  return Array.from({ length: n }, (_, i) => from * Math.pow(to / from, i / (n - 1)))
}

// ---- Routing checks

export interface RoutingWarning {
  stripId: string
  message: string
}

/** Things a sound engineer would flag before going live */
export function routingWarnings(cfg: Pick<MixerConfig, 'strips' | 'buses'>): RoutingWarning[] {
  const warnings: RoutingWarning[] = []
  for (const s of cfg.strips) {
    const outs = s.sends.map((id) => cfg.buses.find((b) => b.id === id)).filter((b): b is Bus => !!b && b.kind === 'out' && !b.mute)
    if (outs.length > 0) warnings.push({ stripId: s.id, message: `${s.name} suena por ${outs.map((b) => b.label).join(', ')}: usa auriculares o se acoplará con altavoces.` })
    if (s.sends.length === 0) warnings.push({ stripId: s.id, message: `${s.name} no está enviada a ningún bus.` })
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
  return JSON.stringify({ app: MIXER_APP, version: 1, strips: cfg.strips, buses: cfg.buses, scenes: cfg.scenes }, null, 2)
}

export function parseMixer(text: string): Pick<MixerConfig, 'strips' | 'buses' | 'scenes'> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  const r = raw as { app?: string; strips?: unknown; buses?: unknown; scenes?: unknown }
  if (!r || r.app !== MIXER_APP || !Array.isArray(r.strips)) throw new Error('No es una configuración del mezclador.')
  const merged = mergeMixer(r as Partial<MixerConfig>)
  return { strips: merged.strips.slice(0, MAX_STRIPS), buses: merged.buses, scenes: merged.scenes }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
