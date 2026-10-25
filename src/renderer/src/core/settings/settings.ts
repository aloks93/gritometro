import type { HandicapRule } from '../players/players'

export interface GameSettings {
  countdownSeconds: number
  screamSeconds: number
  /** Upper limit for the silence challenge */
  silenceMaxSeconds: number
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
    countdownSeconds: 3,
    screamSeconds: 3,
    silenceMaxSeconds: 30,
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
