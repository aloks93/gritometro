import type { CompParams, DeEsserParams, GateParams, LimiterParams } from './dynamics'
import { LOOKAHEAD_MS } from './dynamics'
import { responseDb, type Biquad } from '../studio/dsp'

// Mic processor ("channel strip" for one microphone), meant to sit between a mic and
// VoiceMeeter (or any app): input gain → gate → parametric EQ → de-esser → compressor 1
// → compressor 2 → limiter → output gain. Pure model; the Web Audio graph lives in
// core/audio/ProcessorEngine.ts and the dynamics DSP in ./dynamics.ts.

export type BandType = 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'bandpass'

export interface ParamBand {
  on: boolean
  type: BandType
  freq: number
  gainDb: number
  /** Width for peaking/notch/bandpass, resonance for high/low-pass */
  q: number
  /** High/low-pass steepness, dB per octave */
  slope: 12 | 24 | 36 | 48
}

export interface ProcessorPreset {
  id: string
  name: string
  apply: ProcessingChain
}

/** Everything that shapes the sound (what presets store) */
export interface ProcessingChain {
  gate: GateParams
  eq: { on: boolean; bands: ParamBand[] }
  deesser: DeEsserParams
  comp1: CompParams
  comp2: CompParams
  limiter: LimiterParams
}

export interface ProcessorConfig extends ProcessingChain {
  input: {
    /** null = system default input */
    deviceId: string | null
    /** 0-based device channel, or −1 to mix every channel down */
    channel: number
  }
  inputGainDb: number
  phaseInvert: boolean
  /** EQ before the compressors (classic) or after them */
  eqPosition: 'pre' | 'post'
  outputGainDb: number
  output: {
    /** null = system default output. For VoiceMeeter pick "VoiceMeeter Input" */
    deviceId: string | null
    mute: boolean
  }
  /** Headphone monitoring of the processed signal on another device */
  monitor: { on: boolean; deviceId: string | null; levelDb: number }
  /** Hear the unprocessed mic (A/B) */
  bypass: boolean
  sampleRate: number | null
  /** Presets picked in the toolbar, remembered for the next session */
  useId: string
  micId: string
  userPresets: ProcessorPreset[]
}

export const MAX_BANDS = 8
export const STAGES_PER_BAND = 4
export const GAIN_MIN = -24
export const GAIN_MAX = 36

export const BAND_TYPES: [BandType, string][] = [
  ['peaking', 'Campana'],
  ['lowshelf', 'Shelf graves'],
  ['highshelf', 'Shelf agudos'],
  ['highpass', 'Paso alto'],
  ['lowpass', 'Paso bajo'],
  ['notch', 'Notch'],
  ['bandpass', 'Paso banda']
]

export const hasGain = (t: BandType): boolean => t === 'peaking' || t === 'lowshelf' || t === 'highshelf'
export const hasQ = (t: BandType): boolean => t !== 'lowshelf' && t !== 'highshelf'
export const hasSlope = (t: BandType): boolean => t === 'highpass' || t === 'lowpass'

export function band(type: BandType, freq: number, gainDb = 0, q = 1, on = true, slope: ParamBand['slope'] = 12): ParamBand {
  return { on, type, freq, gainDb, q, slope }
}

/** Eight bands laid out like a voice EQ: low cut, body, mud, box, presence, harshness, air, top cut */
export function defaultBands(): ParamBand[] {
  return [
    band('highpass', 80, 0, 0.71, true, 24),
    band('lowshelf', 150, 0),
    band('peaking', 300, 0, 1.2),
    band('peaking', 800, 0, 1.4),
    band('peaking', 3000, 0, 1),
    band('peaking', 6500, 0, 3),
    band('highshelf', 10000, 0),
    band('lowpass', 18000, 0, 0.71, false, 12)
  ]
}

export const gateDefaults = (): GateParams => ({ on: false, mode: 'expander', thresholdDb: -50, hysteresisDb: 4, rangeDb: -30, ratio: 2, attackMs: 1, holdMs: 120, releaseMs: 180 })
export const deesserDefaults = (): DeEsserParams => ({ on: false, freq: 6500, thresholdDb: -30, rangeDb: -8, mode: 'split', listen: false })
export const comp1Defaults = (): CompParams => ({ on: false, thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 80, makeupDb: 4, mix: 100, detector: 'peak' })
export const comp2Defaults = (): CompParams => ({ on: false, thresholdDb: -24, ratio: 2, kneeDb: 10, attackMs: 30, releaseMs: 400, makeupDb: 2, mix: 100, detector: 'rms' })
export const limiterDefaults = (): LimiterParams => ({ on: true, ceilingDb: -1, releaseMs: 60 })

export function defaultProcessor(): ProcessorConfig {
  return {
    input: { deviceId: null, channel: 0 },
    inputGainDb: 0,
    phaseInvert: false,
    gate: gateDefaults(),
    eq: { on: true, bands: defaultBands() },
    eqPosition: 'pre',
    deesser: deesserDefaults(),
    comp1: comp1Defaults(),
    comp2: comp2Defaults(),
    limiter: limiterDefaults(),
    outputGainDb: 0,
    output: { deviceId: null, mute: false },
    // Off by default: monitoring through speakers would feed back
    monitor: { on: false, deviceId: null, levelDb: -6 },
    bypass: false,
    sampleRate: 48000,
    useId: 'speech',
    micId: 'dynamic',
    userPresets: []
  }
}

const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : d)

function normalizeBand(b: Partial<ParamBand> | undefined, d: ParamBand): ParamBand {
  if (!b) return d
  const type = BAND_TYPES.some(([t]) => t === b.type) ? (b.type as BandType) : d.type
  const slope = [12, 24, 36, 48].includes(b.slope as number) ? (b.slope as ParamBand['slope']) : d.slope
  return { on: b.on ?? d.on, type, freq: num(b.freq, d.freq, 20, 20000), gainDb: num(b.gainDb, d.gainDb, -24, 24), q: num(b.q, d.q, 0.1, 20), slope }
}

export function normalizeChain(c: Partial<ProcessingChain> | undefined, base: ProcessingChain = defaultProcessor()): ProcessingChain {
  const bands = Array.isArray(c?.eq?.bands) && c.eq.bands.length ? c.eq.bands.slice(0, MAX_BANDS).map((b, i) => normalizeBand(b, base.eq.bands[i] ?? band('peaking', 1000))) : base.eq.bands
  return {
    gate: { ...base.gate, ...c?.gate },
    eq: { on: c?.eq?.on ?? base.eq.on, bands },
    deesser: { ...base.deesser, ...c?.deesser },
    comp1: { ...base.comp1, ...c?.comp1 },
    comp2: { ...base.comp2, ...c?.comp2 },
    limiter: { ...base.limiter, ...c?.limiter }
  }
}

/** Fills fields added in newer versions so old saves keep working */
export function mergeProcessor(saved: Partial<ProcessorConfig> | null | undefined): ProcessorConfig {
  const d = defaultProcessor()
  if (!saved) return d
  return {
    ...d,
    ...saved,
    ...normalizeChain(saved, d),
    input: { ...d.input, ...saved.input },
    output: { ...d.output, ...saved.output },
    monitor: { ...d.monitor, ...saved.monitor },
    eqPosition: saved.eqPosition === 'post' ? 'post' : 'pre',
    inputGainDb: num(saved.inputGainDb, d.inputGainDb, GAIN_MIN, GAIN_MAX),
    outputGainDb: num(saved.outputGainDb, d.outputGainDb, -24, 24),
    userPresets: Array.isArray(saved.userPresets) ? saved.userPresets : []
  }
}

export function chainOf(cfg: ProcessingChain): ProcessingChain {
  return clone({ gate: cfg.gate, eq: cfg.eq, deesser: cfg.deesser, comp1: cfg.comp1, comp2: cfg.comp2, limiter: cfg.limiter })
}

// ---- EQ: Web Audio filter settings and their exact response

/** One BiquadFilterNode's settings (Q in Web Audio units: dB for low/high-pass) */
export interface NodeSetting {
  type: BiquadFilterType
  frequency: number
  Q: number
  gain: number
}

/** A peaking filter at 0 dB is an exact pass-through: unused stages stay in the graph like this */
export const IDENTITY: NodeSetting = { type: 'peaking', frequency: 1000, Q: 1, gain: 0 }

/** Butterworth Q of each 2nd-order section for a 2n-order filter */
function butterworthQs(sections: number): number[] {
  const order = sections * 2
  return Array.from({ length: sections }, (_, k) => 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order))))
}

/** The node settings (always STAGES_PER_BAND of them) that realise a band */
export function bandStages(b: ParamBand, eqOn: boolean, sampleRate: number): NodeSetting[] {
  const out: NodeSetting[] = []
  const freq = Math.max(10, Math.min(sampleRate * 0.49, b.freq))
  if (eqOn && b.on) {
    if (hasSlope(b.type)) {
      const qs = butterworthQs(b.slope / 12)
      // The band's Q shapes the last (sharpest) section: 0.71 = flat Butterworth
      qs[qs.length - 1] *= b.q / Math.SQRT1_2
      for (const q of qs) out.push({ type: b.type, frequency: freq, Q: 20 * Math.log10(q), gain: 0 })
    } else {
      out.push({ type: b.type, frequency: freq, Q: b.q, gain: hasGain(b.type) ? b.gainDb : 0 })
    }
  }
  while (out.length < STAGES_PER_BAND) out.push(IDENTITY)
  return out
}

/** Biquad coefficients exactly as the Web Audio spec computes them for a BiquadFilterNode */
export function nodeBiquad(s: NodeSetting, sampleRate: number): Biquad {
  const w = (2 * Math.PI * s.frequency) / sampleRate
  const cos = Math.cos(w)
  const sin = Math.sin(w)
  const A = Math.pow(10, s.gain / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  switch (s.type) {
    case 'lowpass':
    case 'highpass': {
      const alpha = sin / (2 * Math.pow(10, s.Q / 20))
      const lp = s.type === 'lowpass'
      b0 = lp ? (1 - cos) / 2 : (1 + cos) / 2
      b1 = lp ? 1 - cos : -(1 + cos)
      b2 = b0
      a0 = 1 + alpha
      a1 = -2 * cos
      a2 = 1 - alpha
      break
    }
    case 'bandpass':
    case 'notch': {
      const alpha = sin / (2 * s.Q)
      if (s.type === 'bandpass') {
        b0 = alpha
        b1 = 0
        b2 = -alpha
      } else {
        b0 = 1
        b1 = -2 * cos
        b2 = 1
      }
      a0 = 1 + alpha
      a1 = -2 * cos
      a2 = 1 - alpha
      break
    }
    case 'lowshelf':
    case 'highshelf': {
      // Web Audio shelves use a fixed slope S = 1
      const alpha = (sin / 2) * Math.SQRT2
      const k = 2 * Math.sqrt(A) * alpha
      if (s.type === 'lowshelf') {
        b0 = A * (A + 1 - (A - 1) * cos + k)
        b1 = 2 * A * (A - 1 - (A + 1) * cos)
        b2 = A * (A + 1 - (A - 1) * cos - k)
        a0 = A + 1 + (A - 1) * cos + k
        a1 = -2 * (A - 1 + (A + 1) * cos)
        a2 = A + 1 + (A - 1) * cos - k
      } else {
        b0 = A * (A + 1 + (A - 1) * cos + k)
        b1 = -2 * A * (A - 1 + (A + 1) * cos)
        b2 = A * (A + 1 + (A - 1) * cos - k)
        a0 = A + 1 - (A - 1) * cos + k
        a1 = 2 * (A - 1 - (A + 1) * cos)
        a2 = A + 1 - (A - 1) * cos - k
      }
      break
    }
    default: {
      // peaking
      const alpha = sin / (2 * s.Q)
      b0 = 1 + alpha * A
      b1 = -2 * cos
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * cos
      a2 = 1 - alpha / A
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Whole-EQ (or one band) magnitude response in dB at each frequency */
export function eqCurve(eq: ProcessingChain['eq'], freqs: number[], sampleRate = 48000, only?: number): number[] {
  const sections = eq.bands
    .filter((_, i) => only === undefined || i === only)
    .flatMap((b) => bandStages(b, eq.on, sampleRate))
    .filter((s) => s !== IDENTITY)
    .map((s) => nodeBiquad(s, sampleRate))
  return freqs.map((f) => (sections.length ? responseDb(sections, f, sampleRate) : 0))
}

// ---- Presets: use (what the voice is for) × microphone type

export interface UsePreset {
  id: string
  name: string
  hint: string
}

export const USES: UsePreset[] = [
  { id: 'speech', name: 'Voz hablada', hint: 'Natural y clara: reuniones, clases, presentaciones.' },
  { id: 'stream', name: 'Streaming / Discord', hint: 'Presente y constante, sin ruido de teclado entre frases.' },
  { id: 'podcast', name: 'Podcast / locución', hint: 'Voz de radio: cuerpo, presencia y nivel muy estable.' },
  { id: 'singing', name: 'Voz cantada', hint: 'Compresión musical, aire arriba y sin cortar las colas.' },
  { id: 'shout', name: 'Gritos / animación', hint: 'Aguanta gritos sin saturar: mucho margen y limitador firme.' },
  { id: 'clean', name: 'Limpio (solo protección)', hint: 'Solo paso alto y limitador: el sonido del micro tal cual.' }
]

export interface MicPreset {
  id: string
  name: string
  hint: string
}

export const MICS: MicPreset[] = [
  { id: 'dynamic', name: 'Dinámico (SM58, PG48…)', hint: 'Poco brillo y efecto de proximidad: se abre la presencia.' },
  { id: 'condenser', name: 'Condensador de estudio', hint: 'Capta la sala y brilla: más paso alto, menos agudos duros.' },
  { id: 'usb', name: 'Micro USB', hint: 'Suele sonar a caja y con ruido: limpia medios y cierra la puerta antes.' },
  { id: 'headset', name: 'Diadema / headset', hint: 'Muy cerca de la boca: respiraciones y graves de más.' },
  { id: 'lavalier', name: 'Corbatero (lavalier)', hint: 'Lejos de la boca y apagado: más presencia y aire.' }
]

/** Builds a complete chain for a use and a microphone, starting from a flat EQ */
export function buildPreset(useId: string, micId: string): ProcessingChain {
  const bands = defaultBands()
  const set = (i: number, p: Partial<ParamBand>): void => {
    bands[i] = { ...bands[i], ...p }
  }
  const gate = gateDefaults()
  const deesser = deesserDefaults()
  const comp1 = comp1Defaults()
  const comp2 = comp2Defaults()
  const limiter = limiterDefaults()

  switch (useId) {
    case 'speech':
      set(0, { freq: 90 })
      set(2, { gainDb: -2, freq: 300 })
      set(4, { gainDb: 2.5, freq: 3500 })
      set(6, { gainDb: 1.5, freq: 10000 })
      Object.assign(gate, { on: true, mode: 'expander', thresholdDb: -50, ratio: 2, rangeDb: -20 })
      Object.assign(comp1, { on: true, thresholdDb: -20, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 4 })
      Object.assign(deesser, { on: true, thresholdDb: -30, rangeDb: -6 })
      break
    case 'stream':
      set(0, { freq: 100 })
      set(2, { gainDb: -3, freq: 280 })
      set(4, { gainDb: 3.5, freq: 3800 })
      set(6, { gainDb: 2, freq: 11000 })
      Object.assign(gate, { on: true, mode: 'gate', thresholdDb: -45, hysteresisDb: 6, rangeDb: -40, holdMs: 200, releaseMs: 150 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 4, attackMs: 4, releaseMs: 80, makeupDb: 6 })
      Object.assign(comp2, { on: true, thresholdDb: -26, ratio: 2, makeupDb: 2 })
      Object.assign(deesser, { on: true, thresholdDb: -32, rangeDb: -8 })
      break
    case 'podcast':
      set(0, { freq: 80 })
      set(1, { gainDb: 2, freq: 120 })
      set(2, { gainDb: -2.5, freq: 350 })
      set(3, { gainDb: -2, freq: 800 })
      set(4, { gainDb: 3, freq: 4000 })
      set(6, { gainDb: 2.5, freq: 12000 })
      Object.assign(gate, { on: true, mode: 'expander', thresholdDb: -48, ratio: 2.5, rangeDb: -25 })
      Object.assign(comp1, { on: true, thresholdDb: -16, ratio: 6, kneeDb: 4, attackMs: 3, releaseMs: 60, makeupDb: 4 })
      Object.assign(comp2, { on: true, thresholdDb: -24, ratio: 2.5, attackMs: 40, releaseMs: 500, makeupDb: 4 })
      Object.assign(deesser, { on: true, thresholdDb: -32, rangeDb: -8 })
      break
    case 'singing':
      set(0, { freq: 100 })
      set(2, { gainDb: -2, freq: 300, q: 1.4 })
      set(4, { gainDb: 2, freq: 5000, q: 0.8 })
      set(6, { gainDb: 3, freq: 12000 })
      Object.assign(comp1, { on: true, thresholdDb: -18, ratio: 2.5, kneeDb: 10, attackMs: 15, releaseMs: 200, makeupDb: 3 })
      Object.assign(comp2, { on: true, thresholdDb: -22, ratio: 1.8, makeupDb: 1.5 })
      Object.assign(deesser, { on: true, thresholdDb: -28, rangeDb: -6 })
      break
    case 'shout':
      set(0, { freq: 120 })
      set(2, { gainDb: -2, freq: 350 })
      set(5, { gainDb: -3, freq: 3000, q: 1.5 })
      Object.assign(comp1, { on: true, thresholdDb: -14, ratio: 8, kneeDb: 3, attackMs: 1, releaseMs: 100, makeupDb: 2 })
      Object.assign(limiter, { ceilingDb: -2, releaseMs: 100 })
      break
    default:
      // clean: low cut + protection only
      break
  }

  switch (micId) {
    case 'dynamic':
      // Proximity effect and a dull top: thin the lows, lift presence
      set(1, { gainDb: bands[1].gainDb - 1.5, freq: 150 })
      set(4, { gainDb: bands[4].gainDb + 1.5 })
      set(6, { gainDb: bands[6].gainDb + 1 })
      break
    case 'condenser':
      // Picks up the room and is bright already
      set(0, { freq: Math.max(bands[0].freq, 100) })
      set(5, { gainDb: bands[5].gainDb - 2, freq: 6500 })
      set(6, { gainDb: bands[6].gainDb - 1 })
      gate.thresholdDb -= 4
      deesser.thresholdDb -= 2
      break
    case 'usb':
      set(0, { freq: Math.max(bands[0].freq, 110) })
      set(3, { gainDb: bands[3].gainDb - 3, freq: 700, q: 1.6 })
      set(4, { gainDb: bands[4].gainDb + 1 })
      gate.on = useId !== 'singing' && useId !== 'clean'
      gate.thresholdDb += 4
      break
    case 'headset':
      set(0, { freq: Math.max(bands[0].freq, 130) })
      set(1, { gainDb: bands[1].gainDb - 2.5, freq: 180 })
      set(5, { gainDb: bands[5].gainDb - 1.5, freq: 5500 })
      gate.thresholdDb += 6
      break
    case 'lavalier':
      set(0, { freq: Math.max(bands[0].freq, 120) })
      set(4, { gainDb: bands[4].gainDb + 3, freq: 4500 })
      set(6, { gainDb: bands[6].gainDb + 3 })
      deesser.thresholdDb -= 2
      break
  }
  for (const b of bands) b.gainDb = Math.round(b.gainDb * 10) / 10
  return { gate, eq: { on: true, bands }, deesser, comp1, comp2, limiter }
}

export function applyChain(cfg: ProcessorConfig, chain: ProcessingChain): ProcessorConfig {
  return { ...cfg, ...clone(chain) }
}

/** Saves the current processing as a user preset; the same name overwrites */
export function saveUserPreset(cfg: ProcessorConfig, name: string, id = `pp-${Date.now().toString(36)}`): ProcessorConfig {
  const n = name.trim() || `Preset ${cfg.userPresets.length + 1}`
  const existing = cfg.userPresets.find((p) => p.name.toLowerCase() === n.toLowerCase())
  const preset: ProcessorPreset = { id: existing?.id ?? id, name: n, apply: chainOf(cfg) }
  return { ...cfg, userPresets: existing ? cfg.userPresets.map((p) => (p.id === existing.id ? preset : p)) : [...cfg.userPresets, preset] }
}

// ---- Auto setup (the assistant): silence, then normal speech

export interface VoiceMeasurement {
  /** RMS of the room with nobody talking, dBFS (at the current input gain) */
  noiseDb: number
  /** Loudest peak while talking, dBFS */
  peakDb: number
  /** Average RMS of the voiced parts, dBFS */
  speechDb: number
  /** Average voiced spectrum level per region, dB (relative values matter) */
  regions?: { low: number; mud: number; box: number; presence: number; air: number }
}

export interface AutoSetupResult {
  patch: Partial<ProcessorConfig>
  notes: string[]
}

/**
 * Voice target: long-term average speech spectrum (LTASS, Byrne 1994) as per-bin density,
 * relative to the presence region (2–5 kHz), dB. Measured voices are nudged toward it.
 */
export const VOICE_TARGET = { low: 20, mud: 21, box: 15, presence: 0, air: -12 }

/** Frequency ranges of the regions the assistant measures, Hz */
export const VOICE_REGIONS: Record<keyof typeof VOICE_TARGET, [number, number]> = {
  low: [100, 200],
  mud: [200, 400],
  box: [500, 1000],
  presence: [2000, 5000],
  air: [8000, 12000]
}

/**
 * Turns a short measurement into input gain, gate, compressor thresholds and gentle EQ
 * corrections. Peaks land at −12 dBFS so a sudden shout still has headroom.
 */
export function autoSetup(cfg: ProcessorConfig, m: VoiceMeasurement): AutoSetupResult {
  const notes: string[] = []
  if (m.peakDb <= -70 || m.speechDb <= -80) return { patch: {}, notes: ['No se oyó la voz: revisa el micrófono y repite.'] }
  const gain = Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, cfg.inputGainDb - 12 - m.peakDb)) * 2) / 2
  const delta = gain - cfg.inputGainDb
  const noise = m.noiseDb + delta
  const speech = m.speechDb + delta
  const snr = speech - noise
  if (gain >= GAIN_MAX) notes.push('Ganancia digital al máximo: sube el preamplificador del micrófono o de la interfaz.')
  if (snr < 15) notes.push('Mucho ruido de fondo para la voz: acércate al micro o baja el ruido de la sala.')

  // Gate a third of the way from the noise to the voice, never closer than 6 dB to either
  const thr = Math.round(Math.min(speech - 8, Math.max(noise + 6, noise + snr / 3)))
  const gate: GateParams = { ...cfg.gate, on: snr >= 10, thresholdDb: thr }
  if (snr < 10) notes.push('Voz y ruido demasiado cerca: la puerta queda apagada para no cortar palabras.')

  const comp1: CompParams = { ...cfg.comp1, on: true, thresholdDb: Math.round(speech + 4) }
  const comp2: CompParams = { ...cfg.comp2, thresholdDb: Math.round(speech - 2) }
  const deesser: DeEsserParams = { ...cfg.deesser, thresholdDb: Math.round(speech - 6) }

  let eq = cfg.eq
  if (m.regions) {
    const r = m.regions
    const rel = (v: number): number => v - r.presence
    const fix = (diff: number, max: number): number => Math.round(Math.max(-max, Math.min(max, -diff * 0.6)) * 2) / 2
    const corr = {
      low: fix(rel(r.low) - VOICE_TARGET.low, 4),
      mud: fix(rel(r.mud) - VOICE_TARGET.mud, 4),
      box: fix(rel(r.box) - VOICE_TARGET.box, 3),
      air: fix(rel(r.air) - VOICE_TARGET.air, 3)
    }
    const bands = cfg.eq.bands.map((b) => ({ ...b }))
    const nudge = (i: number, type: BandType, freq: number, d: number, label: string): void => {
      if (!bands[i] || Math.abs(d) < 1) return
      bands[i] = { ...bands[i], on: true, type, freq, gainDb: Math.max(-12, Math.min(12, d)), q: type === 'peaking' ? 1.2 : bands[i].q }
      notes.push(`${label}: ${d > 0 ? '+' : ''}${d} dB`)
    }
    nudge(1, 'lowshelf', 150, corr.low, 'Graves')
    nudge(2, 'peaking', 300, corr.mud, 'Barro (300 Hz)')
    nudge(3, 'peaking', 800, corr.box, 'Caja (800 Hz)')
    nudge(6, 'highshelf', 10000, corr.air, 'Aire')
    eq = { ...cfg.eq, on: true, bands }
  }
  notes.unshift(`Ganancia ${gain} dB · ruido ${noise.toFixed(0)} dBFS · voz ${speech.toFixed(0)} dBFS`)
  return { patch: { inputGainDb: gain, gate, comp1, comp2, deesser, eq }, notes }
}

// ---- Routing checks

export interface ProcessorWarning {
  level: 'warn' | 'bad'
  message: string
}

export function processorWarnings(cfg: ProcessorConfig, outputLabel: string | null, monitorLabel: string | null): ProcessorWarning[] {
  const w: ProcessorWarning[] = []
  const virtual = (l: string | null): boolean => !!l && /voicemeeter|vb-audio|cable|virtual|vaio/i.test(l)
  if (!cfg.output.mute && !virtual(outputLabel))
    w.push({ level: 'warn', message: 'La salida no es un dispositivo virtual: con altavoces se acoplará. Elige «VoiceMeeter Input» o usa auriculares.' })
  if (cfg.monitor.on && cfg.monitor.deviceId === cfg.output.deviceId && !cfg.output.mute)
    w.push({ level: 'warn', message: 'La escucha y la salida van al mismo dispositivo: se oirá doble.' })
  if (cfg.monitor.on && virtual(monitorLabel)) w.push({ level: 'warn', message: 'La escucha va a un dispositivo virtual: elige tus auriculares.' })
  if (cfg.bypass) w.push({ level: 'warn', message: 'Bypass activo: sale el micrófono sin procesar.' })
  if (cfg.output.mute) w.push({ level: 'bad', message: 'La salida está silenciada.' })
  if (cfg.deesser.on && cfg.deesser.listen) w.push({ level: 'bad', message: 'De-esser en modo escucha: solo sale la banda de sibilancia.' })
  const boost = cfg.inputGainDb + cfg.outputGainDb + (cfg.comp1.on ? cfg.comp1.makeupDb : 0) + (cfg.comp2.on ? cfg.comp2.makeupDb : 0)
  if (boost > 30) w.push({ level: 'warn', message: 'Mucha ganancia digital acumulada: sube mejor el preamplificador.' })
  return w
}

/** Processing latency added on top of the audio devices', ms */
export function processingLatencyMs(): number {
  return LOOKAHEAD_MS
}

// ---- Files

const PRESET_APP = 'gritometro-procesador'

export function serializePreset(name: string, chain: ProcessingChain): string {
  return JSON.stringify({ app: PRESET_APP, version: 1, name, chain }, null, 2)
}

export function parsePreset(text: string): { name: string; chain: ProcessingChain } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  const r = raw as { app?: string; name?: unknown; chain?: Partial<ProcessingChain> }
  if (!r || r.app !== PRESET_APP || !r.chain) throw new Error('No es un preset del procesador.')
  return { name: typeof r.name === 'string' ? r.name : 'Preset importado', chain: normalizeChain(r.chain) }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
