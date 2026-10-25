import type { HandicapRule } from '../players/players'

export type AppMode = 'party' | 'studio'

export interface GameSettings {
  /** 'studio' = hidden professional mic-testing interface */
  appMode: AppMode
  /** Standalone studio app: the access code was entered on this PC */
  studioUnlocked: boolean
  /** Name of the birthday girl/boy, shown on home, certificates and photos */
  birthdayName: string
  birthdayAge?: number
  countdownSeconds: number
  screamSeconds: number
  /** Upper limit for the silence challenge */
  silenceMaxSeconds: number
  /** Upper limit for the longest-scream challenge */
  sustainMaxSeconds: number
  /** dB above the floor the voice must stay over to keep the longest-scream clock running */
  sustainThresholdDb: number
  /** Score sensitivity: dB above the floor needed for 100 points */
  rangeDb: number
  minBurstMs: number
  handicapEnabled: boolean
  handicapRules: HandicapRule[]
  soundEnabled: boolean
  /** Large type + keyboard hints for a projector/TV */
  projectorMode: boolean
  /** Show live dB SPL next to the score */
  showDb: boolean
}

export function defaultGameSettings(): GameSettings {
  return {
    appMode: 'party',
    studioUnlocked: false,
    birthdayName: 'Luna',
    countdownSeconds: 3,
    screamSeconds: 3,
    silenceMaxSeconds: 30,
    sustainMaxSeconds: 60,
    sustainThresholdDb: 20,
    rangeDb: 50,
    minBurstMs: 150,
    handicapEnabled: true,
    handicapRules: [
      { maxAge: 5, multiplier: 1.3 },
      { maxAge: 8, multiplier: 1.15 }
    ],
    soundEnabled: true,
    projectorMode: false,
    showDb: true
  }
}
