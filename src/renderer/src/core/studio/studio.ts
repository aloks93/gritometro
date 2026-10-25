import type { TakeMetrics, WavFormat } from './analysis'
import type { TimeWeighting, Weighting } from './loudness'

export interface MicCandidate {
  id: string
  name: string
  /** null = system default input */
  deviceId: string | null
  channel: 'mix' | number
  gainDb: number
  metrics?: TakeMetrics
  /** Blind-test rating 1–5 */
  rating?: number
  takenAt?: string
  /** Free-text notes (position, distance, preamp settings…) */
  notes?: string
}

export type SpectrumMode = 'fft' | 'rta' | 'spectrogram'

/** Studio view preferences, remembered between sessions */
export interface StudioPrefs {
  spectrumMode: SpectrumMode
  /** Analyzer smoothing 0..0.95 (higher = slower, steadier) */
  spectrumSmoothing: number
  /** Lowest dB shown on the analyzer */
  spectrumFloorDb: number
  /** Reference pitch for the tuner */
  tunerA4: number
  slmWeighting: Weighting
  slmTime: TimeWeighting
  /** Integrated-loudness target for the LUFS meter (e.g. −14 streaming, −23 broadcast) */
  loudnessTarget: number
  /** Headphone monitoring level in dB; null = off */
  monitorDb: number | null
  /** Output device for monitoring and the signal generator; null = system default */
  outputDeviceId: string | null
}

export interface StudioData {
  candidates: MicCandidate[]
  takeSeconds: number
  silenceSeconds: number
  /** Loudness-match playback so the louder mic doesn't win by default */
  matchLoudness: boolean
  wavFormat: WavFormat
  /** Candidate the response chart subtracts (difference view); null = absolute curves */
  referenceId: string | null
  prefs: StudioPrefs
}

export function defaultStudioPrefs(): StudioPrefs {
  return {
    spectrumMode: 'fft',
    spectrumSmoothing: 0.5,
    spectrumFloorDb: -100,
    tunerA4: 440,
    slmWeighting: 'A',
    slmTime: 'F',
    loudnessTarget: -14,
    monitorDb: null,
    outputDeviceId: null
  }
}

export function defaultStudio(): StudioData {
  return {
    candidates: [],
    takeSeconds: 8,
    silenceSeconds: 2,
    matchLoudness: true,
    wavFormat: 24,
    referenceId: null,
    prefs: defaultStudioPrefs()
  }
}

/** Fills fields added in newer versions, including nested prefs */
export function mergeStudio(saved: Partial<StudioData> | null | undefined): StudioData {
  const d = defaultStudio()
  const s = saved ?? {}
  return { ...d, ...s, candidates: Array.isArray(s.candidates) ? s.candidates : [], prefs: { ...d.prefs, ...(s.prefs ?? {}) } }
}

// ---- Session files: share or archive a comparison (metrics only, audio goes as WAV)

const SESSION_APP = 'gritometro-studio'

export interface StudioSession {
  app: typeof SESSION_APP
  version: 1
  exportedAt: string
  takeSeconds: number
  silenceSeconds: number
  candidates: MicCandidate[]
}

export function serializeSession(studio: StudioData, now = new Date()): string {
  const session: StudioSession = {
    app: SESSION_APP,
    version: 1,
    exportedAt: now.toISOString(),
    takeSeconds: studio.takeSeconds,
    silenceSeconds: studio.silenceSeconds,
    candidates: studio.candidates
  }
  return JSON.stringify(session, null, 2)
}

/** Validates an imported session; throws a Spanish message the UI can show */
export function parseSession(text: string): StudioSession {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  const r = raw as Partial<StudioSession>
  if (!r || r.app !== SESSION_APP || !Array.isArray(r.candidates)) throw new Error('No es una sesión del Gritómetro Studio.')
  const candidates = r.candidates
    .filter((c): c is MicCandidate => !!c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => ({
      ...c,
      deviceId: typeof c.deviceId === 'string' ? c.deviceId : null,
      channel: c.channel === 'mix' || typeof c.channel === 'number' ? c.channel : 'mix',
      gainDb: typeof c.gainDb === 'number' ? c.gainDb : 0,
      metrics: c.metrics && Array.isArray(c.metrics.curve) ? c.metrics : undefined
    }))
  return {
    app: SESSION_APP,
    version: 1,
    exportedAt: typeof r.exportedAt === 'string' ? r.exportedAt : '',
    takeSeconds: typeof r.takeSeconds === 'number' ? r.takeSeconds : 8,
    silenceSeconds: typeof r.silenceSeconds === 'number' ? r.silenceSeconds : 2,
    candidates
  }
}

/** Appends imported candidates, renaming ids that already exist */
export function mergeCandidates(current: MicCandidate[], incoming: MicCandidate[], makeId: () => string): MicCandidate[] {
  const ids = new Set(current.map((c) => c.id))
  return [...current, ...incoming.map((c) => (ids.has(c.id) ? { ...c, id: makeId() } : c))]
}
