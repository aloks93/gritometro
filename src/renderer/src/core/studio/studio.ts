import type { TakeMetrics } from './analysis'

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
}

export interface StudioData {
  candidates: MicCandidate[]
  takeSeconds: number
  silenceSeconds: number
  /** Loudness-match playback so the louder mic doesn't win by default */
  matchLoudness: boolean
}

export function defaultStudio(): StudioData {
  return { candidates: [], takeSeconds: 8, silenceSeconds: 2, matchLoudness: true }
}
