import type { CompParams, DeEsserParams, GateParams, LimiterParams, SaturationParams } from './dynamics'
import { LOOKAHEAD_MS } from './dynamics'
import { noiseLatency, type NoiseParams } from './noise'
import type { ChannelSetup } from './channels'
import { responseDb, type Biquad } from '../studio/dsp'

// Mic processor ("channel strip" for one microphone or instrument: bass, guitar, keys…), meant
// to sit between the source and VoiceMeeter (or any app): input gain → noise reduction → gate → parametric EQ → de-esser
// → compressor 1 → compressor 2 → saturation → limiter → output gain. Pure model; the Web Audio graph lives in
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
  noise: NoiseParams
  gate: GateParams
  eq: { on: boolean; bands: ParamBand[] }
  deesser: DeEsserParams
  comp1: CompParams
  comp2: CompParams
  saturation: SaturationParams
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
  /** Instrument tuner (Afinador tab) */
  tuner: { tuning: string; a4: number }
  userPresets: ProcessorPreset[]
  /** Saved setup of every channel that has been worked on (see channels.ts), by channelKey */
  channels: Record<string, ChannelSetup>
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

export const noiseDefaults = (): NoiseParams => ({ on: false, mode: 'adaptive', reductionDb: -18, sensitivityDb: 0, smoothing: 50, fromHz: 0, resolution: 1024, listenRemoved: false, profile: null })
export const gateDefaults = (): GateParams => ({ on: false, mode: 'expander', thresholdDb: -50, hysteresisDb: 4, rangeDb: -30, ratio: 2, attackMs: 1, holdMs: 120, releaseMs: 180, keyHpfHz: 0, keyLpfHz: 0 })
export const deesserDefaults = (): DeEsserParams => ({ on: false, freq: 6500, q: 1.4, thresholdDb: -30, ratio: 4, rangeDb: -8, mode: 'split', listen: false })
export const comp1Defaults = (): CompParams => ({ on: false, thresholdDb: -18, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 80, makeupDb: 4, autoMakeup: false, mix: 100, detector: 'peak', scHpfHz: 0 })
export const comp2Defaults = (): CompParams => ({ on: false, thresholdDb: -24, ratio: 2, kneeDb: 10, attackMs: 30, releaseMs: 400, makeupDb: 2, autoMakeup: false, mix: 100, detector: 'rms', scHpfHz: 0 })
export const saturationDefaults = (): SaturationParams => ({ on: false, mode: 'tube', driveDb: 6, toneHz: 12000, mix: 35 })
export const limiterDefaults = (): LimiterParams => ({ on: true, ceilingDb: -1, releaseMs: 60 })

export function defaultProcessor(): ProcessorConfig {
  return {
    input: { deviceId: null, channel: 0 },
    inputGainDb: 0,
    phaseInvert: false,
    noise: noiseDefaults(),
    gate: gateDefaults(),
    eq: { on: true, bands: defaultBands() },
    eqPosition: 'pre',
    deesser: deesserDefaults(),
    comp1: comp1Defaults(),
    comp2: comp2Defaults(),
    saturation: saturationDefaults(),
    limiter: limiterDefaults(),
    outputGainDb: 0,
    output: { deviceId: null, mute: false },
    // Off by default: monitoring through speakers would feed back
    monitor: { on: false, deviceId: null, levelDb: -6 },
    bypass: false,
    sampleRate: 48000,
    useId: 'speech',
    micId: 'dynamic',
    tuner: { tuning: 'chromatic', a4: 440 },
    userPresets: [],
    channels: {}
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
  const noise = { ...base.noise, ...c?.noise }
  if (![512, 1024, 2048].includes(noise.resolution)) noise.resolution = 1024
  if (!Array.isArray(noise.profile)) noise.profile = null
  return {
    noise,
    gate: { ...base.gate, ...c?.gate },
    eq: { on: c?.eq?.on ?? base.eq.on, bands },
    deesser: { ...base.deesser, ...c?.deesser },
    comp1: { ...base.comp1, ...c?.comp1 },
    comp2: { ...base.comp2, ...c?.comp2 },
    saturation: { ...base.saturation, ...c?.saturation },
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
    tuner: { tuning: typeof saved.tuner?.tuning === 'string' ? saved.tuner.tuning : d.tuner.tuning, a4: num(saved.tuner?.a4, d.tuner.a4, 415, 466) },
    eqPosition: saved.eqPosition === 'post' ? 'post' : 'pre',
    inputGainDb: num(saved.inputGainDb, d.inputGainDb, GAIN_MIN, GAIN_MAX),
    outputGainDb: num(saved.outputGainDb, d.outputGainDb, -24, 24),
    userPresets: Array.isArray(saved.userPresets) ? saved.userPresets : [],
    channels: mergeChannels(saved.channels)
  }
}

function mergeChannels(raw: unknown): Record<string, ChannelSetup> {
  if (!raw || typeof raw !== 'object') return {}
  const d = defaultProcessor()
  const out: Record<string, ChannelSetup> = {}
  for (const [key, v] of Object.entries(raw as Record<string, Partial<ChannelSetup>>)) {
    if (!v || typeof v !== 'object' || !key.includes('#')) continue
    out[key] = {
      name: typeof v.name === 'string' ? v.name : '',
      note: typeof v.note === 'string' ? v.note : '',
      chain: normalizeChain(v.chain, d),
      inputGainDb: num(v.inputGainDb, 0, GAIN_MIN, GAIN_MAX),
      outputGainDb: num(v.outputGainDb, 0, -24, 24),
      phaseInvert: !!v.phaseInvert,
      eqPosition: v.eqPosition === 'post' ? 'post' : 'pre',
      live: !!v.live,
      outputId: typeof v.outputId === 'string' ? v.outputId : null,
      updatedAt: num(v.updatedAt, 0)
    }
  }
  return out
}

export function chainOf(cfg: ProcessingChain): ProcessingChain {
  return clone({ noise: cfg.noise, gate: cfg.gate, eq: cfg.eq, deesser: cfg.deesser, comp1: cfg.comp1, comp2: cfg.comp2, saturation: cfg.saturation, limiter: cfg.limiter })
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

// ---- Presets: use (what the voice or instrument is for) × microphone / pickup

/** What a use is for: a voice, or an instrument (no de-esser or noise suppression, full low end) */
export type Source = 'voice' | 'instrument'

export interface UsePreset {
  id: string
  name: string
  hint: string
  source: Source
  /** Capture picked when switching to this use from one that doesn't fit */
  defaultMic: string
}

export const USES: UsePreset[] = [
  { id: 'speech', name: 'Voz hablada', hint: 'Natural y clara: reuniones, clases, presentaciones.', source: 'voice', defaultMic: 'dynamic' },
  { id: 'stream', name: 'Streaming / Discord', hint: 'Presente y constante, sin ruido de teclado entre frases.', source: 'voice', defaultMic: 'dynamic' },
  { id: 'podcast', name: 'Podcast / locución', hint: 'Voz de radio: cuerpo, presencia y nivel muy estable.', source: 'voice', defaultMic: 'dynamic' },
  { id: 'singing', name: 'Voz cantada', hint: 'Compresión musical, aire arriba y sin cortar las colas.', source: 'voice', defaultMic: 'condenser' },
  { id: 'shout', name: 'Gritos / animación', hint: 'Aguanta gritos sin saturar: mucho margen y limitador firme.', source: 'voice', defaultMic: 'dynamic' },
  { id: 'clean', name: 'Limpio (solo protección)', hint: 'Solo paso alto y limitador: el sonido del micro tal cual.', source: 'voice', defaultMic: 'dynamic' },
  { id: 'bass-finger', name: 'Bajo eléctrico · dedos', hint: 'Graves firmes y notas parejas: compresión de bajista y sin barro en 250 Hz.', source: 'instrument', defaultMic: 'di' },
  { id: 'bass-pick', name: 'Bajo eléctrico · púa / rock', hint: 'Ataque de púa y medios que cortan en la mezcla, con un poco de saturación.', source: 'instrument', defaultMic: 'di' },
  { id: 'bass-slap', name: 'Bajo eléctrico · slap / funk', hint: 'Curva en V: graves profundos y chasquido arriba; compresión rápida para los golpes.', source: 'instrument', defaultMic: 'di' },
  { id: 'bass-amp', name: 'Bajo · sonido de ampli', hint: 'Bajo directo con carácter de ampli valvular: saturación cálida y agudos redondeados.', source: 'instrument', defaultMic: 'di' },
  { id: 'bass-upright', name: 'Contrabajo / bajo acústico', hint: 'Madera natural: controla el retumbe y deja las notas largas.', source: 'instrument', defaultMic: 'piezo' },
  { id: 'guitar-clean', name: 'Guitarra eléctrica · limpia', hint: 'Brillo y definición sin graves que embarren; compresión suave.', source: 'instrument', defaultMic: 'di' },
  { id: 'guitar-crunch', name: 'Guitarra eléctrica · crunch', hint: 'Saturación de ampli moderada: acordes que rompen un poco y se entienden.', source: 'instrument', defaultMic: 'di' },
  { id: 'guitar-drive', name: 'Guitarra eléctrica · distorsión', hint: 'Ampli saturado, puerta contra el ruido entre riffs y sin arenilla arriba.', source: 'instrument', defaultMic: 'di' },
  { id: 'guitar-acoustic', name: 'Guitarra acústica', hint: 'Cuerpo sin retumbe de la boca, brillo de cuerdas y dinámica natural.', source: 'instrument', defaultMic: 'sdc' },
  { id: 'keys', name: 'Teclado / piano', hint: 'Rango completo intacto, solo control de picos.', source: 'instrument', defaultMic: 'di' },
  { id: 'drum-kick', name: 'Batería · bombo', hint: 'Grave profundo y click del parche, sin cartón en 300–400 Hz; puerta que solo abre con el bombo.', source: 'instrument', defaultMic: 'kick-dyn' },
  { id: 'drum-snare', name: 'Batería · caja', hint: 'Cuerpo en 200 Hz y chasquido arriba, sin el anillo metálico; puerta que ignora el bombo.', source: 'instrument', defaultMic: 'instrument-dyn' },
  { id: 'drum-toms', name: 'Batería · toms', hint: 'Golpe redondo y ataque, sin cartón; la puerta deja sonar la cola del tom.', source: 'instrument', defaultMic: 'instrument-dyn' },
  { id: 'drum-hihat', name: 'Batería · hi-hat / ride', hint: 'Solo el metal: paso alto firme para quitar caja y bombo, brillo sin estridencia.', source: 'instrument', defaultMic: 'sdc' },
  { id: 'drum-overheads', name: 'Batería · overheads', hint: 'La imagen de toda la batería y los platos: graves limpios, platos sin agresividad.', source: 'instrument', defaultMic: 'sdc' },
  { id: 'drum-kit', name: 'Batería completa · un micrófono', hint: 'Una sola toma para todo el kit: graves y brillo, y compresión en paralelo para que pegue.', source: 'instrument', defaultMic: 'condenser' },
  { id: 'drum-electronic', name: 'Batería electrónica', hint: 'Módulo por línea: rango completo y solo control de picos.', source: 'instrument', defaultMic: 'di' },
  { id: 'percussion', name: 'Cajón / percusión', hint: 'Golpe firme con ataque rápido, sin caja en 400 Hz.', source: 'instrument', defaultMic: 'instrument-dyn' },
  { id: 'instrument-clean', name: 'Instrumento limpio (solo protección)', hint: 'Solo un paso alto muy bajo y el limitador: el instrumento tal cual.', source: 'instrument', defaultMic: 'di' }
]

export interface MicPreset {
  id: string
  name: string
  hint: string
  /** Which uses it shows up for */
  fits: Source | 'both'
  group: 'voice' | 'instrument' | 'direct'
}

export const MICS: MicPreset[] = [
  { id: 'dynamic', name: 'Dinámico (SM58, PG48…)', hint: 'Poco brillo y efecto de proximidad: se abre la presencia.', fits: 'both', group: 'voice' },
  { id: 'condenser', name: 'Condensador de estudio', hint: 'Capta la sala y brilla: más paso alto, menos agudos duros.', fits: 'both', group: 'voice' },
  { id: 'usb', name: 'Micro USB', hint: 'Suele sonar a caja y con ruido: limpia medios y cierra la puerta antes.', fits: 'voice', group: 'voice' },
  { id: 'headset', name: 'Diadema / headset', hint: 'Muy cerca de la boca: respiraciones y graves de más.', fits: 'voice', group: 'voice' },
  { id: 'lavalier', name: 'Corbatero (lavalier)', hint: 'Lejos de la boca y apagado: más presencia y aire.', fits: 'voice', group: 'voice' },
  { id: 'shotgun', name: 'Cañón (shotgun)', hint: 'Direccional y fino: se recupera cuerpo y se cuida la sibilancia.', fits: 'voice', group: 'voice' },
  { id: 'ribbon', name: 'Cinta (ribbon)', hint: 'Oscuro y suave: se abren los agudos y se controla el grave de proximidad.', fits: 'both', group: 'instrument' },
  { id: 'instrument-dyn', name: 'Dinámico de instrumento (SM57, e609…)', hint: 'Frente al ampli o la caja: medios marcados; se limpia la caja y se da aire.', fits: 'both', group: 'instrument' },
  { id: 'kick-dyn', name: 'Dinámico de graves (D112, Beta 52…)', hint: 'Para ampli de bajo, bombo o cajón: graves profundos y pico de ataque.', fits: 'instrument', group: 'instrument' },
  { id: 'sdc', name: 'Condensador lápiz (SM81, KM184…)', hint: 'Detallado y rápido, ideal para acústica: se suaviza el brillo duro.', fits: 'both', group: 'instrument' },
  { id: 'di', name: 'Línea / DI (pastilla pasiva, directo a la interfaz)', hint: 'Señal limpia y sin sala: todo el grave intacto y puerta suave contra el zumbido.', fits: 'instrument', group: 'direct' },
  { id: 'active', name: 'Pastillas activas (con batería)', hint: 'Más nivel y más agudos: se suaviza el brillo y la puerta abre más arriba.', fits: 'instrument', group: 'direct' },
  { id: 'piezo', name: 'Pastilla piezo (acústica, contrabajo)', hint: 'Suena dura y nasal: se quita el graznido de 1–3 kHz y el pico agudo.', fits: 'instrument', group: 'direct' }
]

export const MIC_GROUPS: [MicPreset['group'], string][] = [
  ['voice', 'Micrófonos'],
  ['instrument', 'Micrófonos de instrumento'],
  ['direct', 'Directo (sin micrófono)']
]

/** Headings of the use picker; a use goes to the first group whose test matches */
export const USE_GROUPS: [string, string, (u: UsePreset) => boolean][] = [
  ['voice', 'Voz', (u) => u.source === 'voice'],
  ['bass', 'Bajo', (u) => u.id.startsWith('bass')],
  ['guitar', 'Guitarra', (u) => u.id.startsWith('guitar')],
  ['drums', 'Batería y percusión', (u) => u.id.startsWith('drum') || u.id === 'percussion'],
  ['other', 'Otros instrumentos', () => true]
]

export const useGroupOf = (u: UsePreset): string => USE_GROUPS.find(([, , test]) => test(u))![0]

export const sourceOf = (useId: string): Source => USES.find((u) => u.id === useId)?.source ?? 'voice'
export const isInstrument = (useId: string): boolean => sourceOf(useId) === 'instrument'

/** Microphones / pickups that make sense for a use */
export function micsFor(useId: string): MicPreset[] {
  const src = sourceOf(useId)
  return MICS.filter((m) => m.fits === 'both' || m.fits === src)
}

/**
 * Switching between two voice uses (or two instrument uses) keeps the mic when it fits;
 * crossing from voice to instrument or back picks the new use's usual capture
 */
export function selectUse(cfg: ProcessorConfig, useId: string): ProcessorConfig {
  const keep = sourceOf(cfg.useId) === sourceOf(useId) && micsFor(useId).some((m) => m.id === cfg.micId)
  return { ...cfg, useId, micId: keep ? cfg.micId : (USES.find((u) => u.id === useId)?.defaultMic ?? cfg.micId) }
}

/** Builds a complete chain for a use and a microphone, starting from a flat EQ */
export function buildPreset(useId: string, micId: string): ProcessingChain {
  if (isInstrument(useId)) return buildInstrumentPreset(useId, micId)
  const bands = defaultBands()
  const set = (i: number, p: Partial<ParamBand>): void => {
    bands[i] = { ...bands[i], ...p }
  }
  const noise = noiseDefaults()
  const gate = gateDefaults()
  const deesser = deesserDefaults()
  const saturation = saturationDefaults()
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
      Object.assign(gate, { on: true, mode: 'gate', thresholdDb: -45, hysteresisDb: 6, rangeDb: -40, holdMs: 200, releaseMs: 150, keyHpfHz: 120 })
      Object.assign(noise, { on: true, reductionDb: -15 })
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
      Object.assign(comp1, { on: true, thresholdDb: -16, ratio: 6, kneeDb: 4, attackMs: 3, releaseMs: 60, makeupDb: 4, scHpfHz: 100 })
      Object.assign(noise, { on: true, reductionDb: -12, smoothing: 65 })
      Object.assign(saturation, { on: true, mode: 'tube', driveDb: 6, mix: 25 })
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
      Object.assign(saturation, { on: true, mode: 'tape', driveDb: 4, mix: 20, toneHz: 14000 })
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
      // USB mics are usually noisy: suppression on unless the sound must stay untouched
      if (useId !== 'clean') Object.assign(noise, { on: true, reductionDb: Math.min(noise.reductionDb, -15) })
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
    case 'shotgun':
      // Thin and very directional: some body back, sibilance is exaggerated
      set(1, { gainDb: bands[1].gainDb + 1.5, freq: 160 })
      set(5, { gainDb: bands[5].gainDb - 1.5, freq: 7000 })
      deesser.thresholdDb -= 3
      gate.thresholdDb -= 2
      break
    case 'ribbon':
      // Dark figure-8: open the top, calm the proximity boom
      set(1, { gainDb: bands[1].gainDb - 2, freq: 150 })
      set(6, { gainDb: bands[6].gainDb + 3, freq: 9000 })
      gate.thresholdDb -= 3
      break
    case 'instrument-dyn':
      // SM57-style: presence peak of its own, a little thin
      set(1, { gainDb: bands[1].gainDb + 1, freq: 150 })
      set(5, { gainDb: bands[5].gainDb - 1.5, freq: 6000 })
      set(6, { gainDb: bands[6].gainDb + 1 })
      break
    case 'sdc':
      set(0, { freq: Math.max(bands[0].freq, 100) })
      set(5, { gainDb: bands[5].gainDb - 2, freq: 7000 })
      gate.thresholdDb -= 4
      deesser.thresholdDb -= 2
      break
  }
  for (const b of bands) b.gainDb = Math.round(b.gainDb * 10) / 10
  return { noise, gate, eq: { on: true, bands }, deesser, comp1, comp2, saturation, limiter }
}

/**
 * Eight bands laid out for an instrument: low cut, lows, low mids, mids, upper mids, highs,
 * top shelf, top cut. Low cut at 30 Hz so a 5-string bass (B0 ≈ 31 Hz) keeps its fundamental.
 */
export function instrumentBands(): ParamBand[] {
  return [
    band('highpass', 30, 0, 0.71, true, 24),
    band('lowshelf', 100, 0),
    band('peaking', 250, 0, 1.2),
    band('peaking', 800, 0, 1.2),
    band('peaking', 2500, 0, 1),
    band('peaking', 5000, 0, 1.5),
    band('highshelf', 8000, 0),
    band('lowpass', 16000, 0, 0.71, false, 12)
  ]
}

function buildInstrumentPreset(useId: string, micId: string): ProcessingChain {
  const bands = instrumentBands()
  const set = (i: number, p: Partial<ParamBand>): void => {
    bands[i] = { ...bands[i], ...p }
  }
  const add = (i: number, db: number): void => set(i, { gainDb: bands[i].gainDb + db })
  // Instruments ring out: no spectral suppression (it eats sustain) and no de-esser
  const noise = noiseDefaults()
  const deesser = deesserDefaults()
  // Expander instead of a hard gate so note tails fade instead of chopping
  const gate: GateParams = { ...gateDefaults(), on: true, mode: 'expander', thresholdDb: -62, ratio: 1.6, rangeDb: -15, attackMs: 0.5, holdMs: 150, releaseMs: 300 }
  const saturation = saturationDefaults()
  const comp1 = comp1Defaults()
  const comp2 = comp2Defaults()
  const limiter = limiterDefaults()
  const bass = useId.startsWith('bass')
  // Sources whose fundamental sits low: a mic choice must not raise their low cut
  const deep = bass || ['drum-kick', 'drum-toms', 'drum-kit', 'drum-electronic', 'percussion'].includes(useId)

  switch (useId) {
    case 'bass-finger':
      set(0, { freq: 32 })
      set(1, { gainDb: 2, freq: 80 })
      set(2, { gainDb: -3, freq: 250 })
      set(3, { gainDb: 1.5, freq: 800, q: 1 })
      set(4, { gainDb: 1.5, freq: 2000 })
      set(6, { gainDb: -2, freq: 7000 })
      set(7, { on: true, freq: 12000 })
      // Slow attack lets the pluck through; the leveler evens out the strings
      Object.assign(comp1, { on: true, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 15, releaseMs: 150, makeupDb: 4 })
      Object.assign(comp2, { on: true, thresholdDb: -24, ratio: 2.5, kneeDb: 8, attackMs: 30, releaseMs: 300, makeupDb: 2 })
      Object.assign(saturation, { on: true, mode: 'tube', driveDb: 4, mix: 20, toneHz: 8000 })
      break
    case 'bass-pick':
      set(0, { freq: 35 })
      set(1, { gainDb: 1.5, freq: 90 })
      set(2, { gainDb: -2.5, freq: 300 })
      set(3, { gainDb: 2, freq: 800 })
      set(4, { gainDb: 2.5, freq: 1800, q: 1.2 })
      set(6, { gainDb: -1, freq: 7000 })
      set(7, { on: true, freq: 10000 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 100, makeupDb: 5 })
      Object.assign(comp2, { on: true, thresholdDb: -24, ratio: 2, makeupDb: 1.5 })
      Object.assign(saturation, { on: true, mode: 'tube', driveDb: 9, mix: 35, toneHz: 7000 })
      break
    case 'bass-slap':
      set(0, { freq: 32 })
      set(1, { gainDb: 3, freq: 70 })
      set(2, { gainDb: -2, freq: 250 })
      set(3, { gainDb: -3, freq: 550, q: 1 })
      set(4, { gainDb: 2, freq: 2500 })
      set(5, { gainDb: 3, freq: 4500, q: 1.2 })
      set(6, { gainDb: 1.5, freq: 9000 })
      // Fast attack catches the pops before the limiter has to
      Object.assign(comp1, { on: true, thresholdDb: -18, ratio: 6, kneeDb: 3, attackMs: 1, releaseMs: 60, makeupDb: 4 })
      Object.assign(comp2, { on: true, thresholdDb: -24, ratio: 2, makeupDb: 1.5 })
      Object.assign(limiter, { releaseMs: 40 })
      break
    case 'bass-amp':
      set(0, { freq: 35 })
      set(1, { gainDb: 2.5, freq: 90 })
      set(2, { gainDb: -1.5, freq: 300 })
      set(3, { gainDb: 2.5, freq: 700, q: 0.9 })
      set(4, { gainDb: -1, freq: 2500 })
      set(6, { gainDb: -4, freq: 5000 })
      set(7, { on: true, freq: 6000, slope: 24 })
      Object.assign(comp1, { on: true, thresholdDb: -20, ratio: 4, attackMs: 10, releaseMs: 150, makeupDb: 3 })
      Object.assign(saturation, { on: true, mode: 'amp', driveDb: 10, mix: 45, toneHz: 5000 })
      break
    case 'bass-upright':
      set(0, { freq: 38 })
      set(2, { gainDb: -3, freq: 180, q: 1.5 })
      set(3, { gainDb: -1.5, freq: 700 })
      set(4, { gainDb: 1.5, freq: 1500 })
      set(6, { gainDb: -2, freq: 7000 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 3, kneeDb: 8, attackMs: 20, releaseMs: 200, makeupDb: 3 })
      break
    case 'guitar-clean':
      set(0, { freq: 85 })
      set(1, { gainDb: -1, freq: 150 })
      set(2, { gainDb: -2, freq: 300 })
      set(4, { gainDb: 2, freq: 3000 })
      set(6, { gainDb: 2, freq: 9000 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 3, kneeDb: 8, attackMs: 10, releaseMs: 150, makeupDb: 3 })
      Object.assign(saturation, { on: true, mode: 'tape', driveDb: 3, mix: 15, toneHz: 12000 })
      break
    case 'guitar-crunch':
      set(0, { freq: 90 })
      set(2, { gainDb: -2, freq: 250 })
      set(3, { gainDb: 2, freq: 900, q: 1 })
      set(5, { gainDb: -2, freq: 6000, q: 2 })
      set(6, { gainDb: -1.5, freq: 9000 })
      set(7, { on: true, freq: 10000 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 2 })
      Object.assign(saturation, { on: true, mode: 'amp', driveDb: 12, mix: 80, toneHz: 7000 })
      break
    case 'guitar-drive':
      set(0, { freq: 100 })
      set(2, { gainDb: -2.5, freq: 250 })
      set(3, { gainDb: 1.5, freq: 800, q: 1 })
      set(4, { gainDb: 1, freq: 2500 })
      set(5, { gainDb: -3, freq: 6500, q: 2 })
      set(6, { gainDb: -2, freq: 9000 })
      set(7, { on: true, freq: 8500, slope: 24 })
      // High gain brings up hum and pickup noise: a real gate between riffs, keyed above the hum
      Object.assign(gate, { mode: 'gate', thresholdDb: -50, hysteresisDb: 6, rangeDb: -60, attackMs: 0.3, holdMs: 50, releaseMs: 90, keyHpfHz: 200 })
      Object.assign(comp1, { on: true, thresholdDb: -20, ratio: 3, attackMs: 10, releaseMs: 100, makeupDb: 0 })
      Object.assign(saturation, { on: true, mode: 'amp', driveDb: 20, mix: 100, toneHz: 6000 })
      Object.assign(limiter, { ceilingDb: -1.5 })
      break
    case 'guitar-acoustic':
      set(0, { freq: 80 })
      set(1, { gainDb: -1, freq: 120 })
      set(2, { gainDb: -3, freq: 200, q: 1.4 })
      set(3, { gainDb: -1.5, freq: 800 })
      set(4, { gainDb: 1.5, freq: 3000 })
      set(6, { gainDb: 2.5, freq: 10000 })
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 3, kneeDb: 8, attackMs: 10, releaseMs: 150, makeupDb: 3 })
      Object.assign(comp2, { on: true, thresholdDb: -26, ratio: 1.8, makeupDb: 1.5 })
      Object.assign(gate, { thresholdDb: -58, ratio: 1.8 })
      break
    case 'keys':
      set(0, { freq: 25, slope: 12 })
      set(2, { gainDb: -1, freq: 300 })
      set(6, { gainDb: 1, freq: 12000 })
      gate.on = false
      Object.assign(comp1, { on: true, thresholdDb: -16, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 200, makeupDb: 1 })
      break
    case 'drum-kick':
      set(0, { freq: 30 })
      set(1, { gainDb: 3, freq: 60 })
      set(2, { gainDb: -4, freq: 350, q: 1.4 })
      set(3, { gainDb: -2, freq: 700, q: 1.2 })
      set(4, { gainDb: 3, freq: 3500, q: 1.2 })
      set(6, { gainDb: -2, freq: 8000 })
      set(7, { on: true, freq: 10000 })
      // Keyed on the lows so the snare's bleed doesn't open it
      Object.assign(gate, { mode: 'gate', thresholdDb: -35, hysteresisDb: 6, rangeDb: -40, attackMs: 0.2, holdMs: 40, releaseMs: 100, keyLpfHz: 1000 })
      Object.assign(comp1, { on: true, thresholdDb: -16, ratio: 4, kneeDb: 4, attackMs: 10, releaseMs: 60, makeupDb: 2 })
      Object.assign(limiter, { releaseMs: 40 })
      break
    case 'drum-snare':
      set(0, { freq: 80 })
      set(2, { gainDb: 2, freq: 200, q: 1.4 })
      set(3, { gainDb: -3, freq: 900, q: 2 })
      set(4, { gainDb: 2.5, freq: 4000 })
      set(6, { gainDb: 2, freq: 10000 })
      // Keyed above the kick so only the snare opens it
      Object.assign(gate, { mode: 'gate', thresholdDb: -32, hysteresisDb: 6, rangeDb: -25, attackMs: 0.2, holdMs: 60, releaseMs: 150, keyHpfHz: 150 })
      Object.assign(comp1, { on: true, thresholdDb: -18, ratio: 4, kneeDb: 4, attackMs: 5, releaseMs: 80, makeupDb: 3 })
      Object.assign(limiter, { releaseMs: 40 })
      break
    case 'drum-toms':
      set(0, { freq: 60 })
      set(1, { gainDb: 2, freq: 100 })
      set(2, { gainDb: -4, freq: 400, q: 1.2 })
      set(4, { gainDb: 2.5, freq: 3500 })
      set(6, { gainDb: -1, freq: 8000 })
      // Long hold and release: toms ring, the gate only removes bleed between hits
      Object.assign(gate, { mode: 'gate', thresholdDb: -35, hysteresisDb: 6, rangeDb: -30, attackMs: 0.2, holdMs: 120, releaseMs: 250, keyHpfHz: 80 })
      Object.assign(comp1, { on: true, thresholdDb: -18, ratio: 3, kneeDb: 4, attackMs: 10, releaseMs: 120, makeupDb: 2 })
      break
    case 'drum-hihat':
      set(0, { freq: 300, slope: 24 })
      set(3, { gainDb: -2, freq: 1000 })
      set(5, { gainDb: -1.5, freq: 5000, q: 2 })
      set(6, { gainDb: 2, freq: 10000 })
      gate.on = false
      break
    case 'drum-overheads':
      set(0, { freq: 100 })
      set(2, { gainDb: -2, freq: 400, q: 1 })
      set(5, { gainDb: -1.5, freq: 3500, q: 2 })
      set(6, { gainDb: 2, freq: 12000 })
      gate.on = false
      Object.assign(comp1, { on: true, thresholdDb: -20, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 150, makeupDb: 1 })
      break
    case 'drum-kit':
      set(0, { freq: 40 })
      set(1, { gainDb: 2, freq: 80 })
      set(2, { gainDb: -3, freq: 400 })
      set(4, { gainDb: 1.5, freq: 3000 })
      set(6, { gainDb: 1.5, freq: 10000 })
      gate.on = false
      Object.assign(comp1, { on: true, thresholdDb: -22, ratio: 4, kneeDb: 4, attackMs: 15, releaseMs: 120, makeupDb: 3 })
      // Parallel ("New York") compression: crushed copy mixed under the dry kit
      Object.assign(comp2, { on: true, thresholdDb: -30, ratio: 8, kneeDb: 2, attackMs: 2, releaseMs: 100, makeupDb: 4, mix: 35, detector: 'peak' })
      break
    case 'drum-electronic':
      set(0, { freq: 25, slope: 12 })
      gate.on = false
      Object.assign(comp1, { on: true, thresholdDb: -14, ratio: 2, kneeDb: 10, attackMs: 10, releaseMs: 100, makeupDb: 1 })
      break
    case 'percussion':
      set(0, { freq: 40 })
      set(1, { gainDb: 3, freq: 80 })
      set(2, { gainDb: -4, freq: 400 })
      set(4, { gainDb: 3, freq: 3500 })
      set(6, { gainDb: 1, freq: 10000 })
      Object.assign(gate, { mode: 'gate', thresholdDb: -40, hysteresisDb: 6, rangeDb: -30, attackMs: 0.2, holdMs: 60, releaseMs: 120 })
      Object.assign(comp1, { on: true, thresholdDb: -18, ratio: 4, kneeDb: 4, attackMs: 8, releaseMs: 80, makeupDb: 3 })
      Object.assign(limiter, { releaseMs: 40 })
      break
    default:
      // instrument-clean: very low cut + protection
      set(0, { freq: 25, slope: 12 })
      gate.on = false
      break
  }

  switch (micId) {
    case 'di':
      // Clean line signal: the expander only needs to catch the hum floor
      gate.thresholdDb -= 4
      break
    case 'active':
      // Hotter and brighter than passive pickups
      add(6, -1.5)
      gate.thresholdDb += 4
      break
    case 'piezo':
      // Quack and a spiky top
      set(5, { gainDb: bands[5].gainDb - 3, freq: bass ? 1200 : 2500, q: 1.5 })
      add(6, -1.5)
      set(7, { on: true, freq: Math.min(bands[7].on ? bands[7].freq : 20000, 10000) })
      break
    case 'dynamic':
    case 'instrument-dyn':
      // In front of the amp or skin: some boxiness, a little short on air
      add(3, -1.5)
      add(6, 1.5)
      gate.thresholdDb += 6
      break
    case 'kick-dyn':
      add(1, 1.5)
      add(3, -2)
      gate.thresholdDb += 6
      break
    case 'condenser':
    case 'sdc':
      // Detailed and picks up the room
      set(0, { freq: Math.max(bands[0].freq, deep ? 35 : 70) })
      add(5, -1.5)
      gate.thresholdDb += 4
      break
    case 'ribbon':
      add(1, -1.5)
      add(6, 2.5)
      gate.thresholdDb += 4
      break
  }
  for (const b of bands) b.gainDb = Math.round(b.gainDb * 10) / 10
  return { noise, gate, eq: { on: true, bands }, deesser, comp1, comp2, saturation, limiter }
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
  const inst = isInstrument(cfg.useId)
  if (m.peakDb <= -70 || m.speechDb <= -80)
    return { patch: {}, notes: [inst ? 'No se oyó el instrumento: revisa el cable y su volumen, y repite.' : 'No se oyó la voz: revisa el micrófono y repite.'] }
  const gain = Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, cfg.inputGainDb - 12 - m.peakDb)) * 2) / 2
  const delta = gain - cfg.inputGainDb
  const noise = m.noiseDb + delta
  const speech = m.speechDb + delta
  const snr = speech - noise
  if (gain >= GAIN_MAX) notes.push('Ganancia digital al máximo: sube el preamplificador del micrófono o de la interfaz.')
  if (snr < 15)
    notes.push(inst ? 'Mucho ruido para el instrumento: revisa cables y masa, y aléjalo del monitor y del PC.' : 'Mucho ruido de fondo para la voz: acércate al micro o baja el ruido de la sala.')

  // Gate a third of the way from the noise to the voice, never closer than 6 dB to either.
  // Instruments decay slowly: a quarter of the way, so note tails survive
  const thr = Math.round(Math.min(speech - 8, Math.max(noise + 6, noise + snr / (inst ? 4 : 3))))
  const gate: GateParams = { ...cfg.gate, on: snr >= 10, thresholdDb: thr }
  if (snr < 10) notes.push(inst ? 'Instrumento y ruido demasiado cerca: la puerta queda apagada para no cortar notas.' : 'Voz y ruido demasiado cerca: la puerta queda apagada para no cortar palabras.')

  // A noisy room gets the suppressor; a quiet one keeps the voice untouched. Never for
  // instruments: it smears sustain and chords (the gate handles hum between notes)
  const noiseP = !inst && snr < 30 ? { ...cfg.noise, on: true, reductionDb: snr < 18 ? -20 : -12 } : cfg.noise
  if (!inst && snr < 30) notes.push('Reducción de ruido activada.')
  const comp1: CompParams = { ...cfg.comp1, on: true, thresholdDb: Math.round(speech + 4) }
  const comp2: CompParams = { ...cfg.comp2, thresholdDb: Math.round(speech - 2) }
  const deesser: DeEsserParams = { ...cfg.deesser, thresholdDb: Math.round(speech - 6) }

  let eq = cfg.eq
  // The EQ target is a voice spectrum: instruments keep their preset's EQ
  if (m.regions && !inst) {
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
  notes.unshift(`Ganancia ${gain} dB · ruido ${noise.toFixed(0)} dBFS · ${inst ? 'instrumento' : 'voz'} ${speech.toFixed(0)} dBFS`)
  if (inst) return { patch: { inputGainDb: gain, gate, comp1, comp2 }, notes }
  return { patch: { inputGainDb: gain, noise: noiseP, gate, comp1, comp2, deesser, eq }, notes }
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
  if (cfg.noise.on && cfg.noise.listenRemoved) w.push({ level: 'bad', message: 'Reducción de ruido en modo escucha: solo sale el ruido eliminado.' })
  if (cfg.noise.on && cfg.noise.mode === 'learned' && !cfg.noise.profile)
    w.push({ level: 'warn', message: 'Reducción de ruido sin perfil aprendido: usa «Aprender» en silencio (mientras, se adapta sola).' })
  if (isInstrument(cfg.useId) && cfg.noise.on)
    w.push({ level: 'warn', message: 'Reducción de ruido con un instrumento: recorta las colas de las notas y suma latencia. Para el zumbido usa la puerta.' })
  const boost = cfg.inputGainDb + cfg.outputGainDb + (cfg.comp1.on ? cfg.comp1.makeupDb : 0) + (cfg.comp2.on ? cfg.comp2.makeupDb : 0)
  if (boost > 30) w.push({ level: 'warn', message: 'Mucha ganancia digital acumulada: sube mejor el preamplificador.' })
  return w
}

/** Processing latency added on top of the audio devices', ms */
export function processingLatencyMs(cfg: Pick<ProcessorConfig, 'noise'>, sampleRate = 48000): number {
  return LOOKAHEAD_MS + (noiseLatency(cfg.noise.resolution) / sampleRate) * 1000
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
