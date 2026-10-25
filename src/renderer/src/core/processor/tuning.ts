// Instrument tuner: string tunings and the nearest string to a detected pitch.
// Pitch detection itself is YIN (core/studio/pitch.ts) on the processor's raw input.

export interface Tuning {
  id: string
  name: string
  /** MIDI note of every string, lowest first (empty = chromatic) */
  strings: number[]
}

// MIDI: E1 = 28, B0 = 23, E2 = 40, A4 = 69
export const TUNINGS: Tuning[] = [
  { id: 'chromatic', name: 'Cromático', strings: [] },
  { id: 'bass4', name: 'Bajo 4 cuerdas (Mi La Re Sol)', strings: [28, 33, 38, 43] },
  { id: 'bass5', name: 'Bajo 5 cuerdas (Si Mi La Re Sol)', strings: [23, 28, 33, 38, 43] },
  { id: 'bass6', name: 'Bajo 6 cuerdas (Si Mi La Re Sol Do)', strings: [23, 28, 33, 38, 43, 48] },
  { id: 'bass4-dropd', name: 'Bajo Drop D (Re La Re Sol)', strings: [26, 33, 38, 43] },
  { id: 'bass4-half', name: 'Bajo ½ tono abajo (Mi♭)', strings: [27, 32, 37, 42] },
  { id: 'guitar', name: 'Guitarra estándar (Mi La Re Sol Si Mi)', strings: [40, 45, 50, 55, 59, 64] },
  { id: 'guitar-dropd', name: 'Guitarra Drop D', strings: [38, 45, 50, 55, 59, 64] },
  { id: 'guitar-half', name: 'Guitarra ½ tono abajo (Mi♭)', strings: [39, 44, 49, 54, 58, 63] },
  { id: 'guitar-dadgad', name: 'Guitarra DADGAD', strings: [38, 45, 50, 55, 57, 62] },
  { id: 'guitar7', name: 'Guitarra 7 cuerdas (Si…)', strings: [35, 40, 45, 50, 55, 59, 64] },
  { id: 'ukulele', name: 'Ukelele (Sol Do Mi La)', strings: [67, 60, 64, 69] },
  { id: 'violin', name: 'Violín (Sol Re La Mi)', strings: [55, 62, 69, 76] }
]

const SOLFEGE = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']

export const midiHz = (midi: number, a4 = 440): number => a4 * Math.pow(2, (midi - 69) / 12)

export function midiName(midi: number): string {
  return `${SOLFEGE[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export interface StringMatch {
  /** Index in the tuning (0 = lowest string as listed) */
  index: number
  midi: number
  name: string
  targetHz: number
  /** Deviation from that string, cents (can go past ±50 on a badly tuned string) */
  cents: number
}

/** The string of `tuning` closest to `hz` (in cents), or null for a chromatic tuning */
export function nearestString(hz: number, tuning: Tuning, a4 = 440): StringMatch | null {
  if (!tuning.strings.length || !(hz > 0)) return null
  let best: StringMatch | null = null
  tuning.strings.forEach((midi, index) => {
    const targetHz = midiHz(midi, a4)
    const cents = 1200 * Math.log2(hz / targetHz)
    if (!best || Math.abs(cents) < Math.abs(best.cents)) best = { index, midi, name: midiName(midi), targetHz, cents }
  })
  return best
}

/** Lowest pitch the tuner must detect for a tuning, Hz (a little under the lowest string) */
export function tunerMinHz(tuning: Tuning, a4 = 440): number {
  if (!tuning.strings.length) return 27
  return Math.max(25, midiHz(Math.min(...tuning.strings), a4) * 0.8)
}

/**
 * Smooths readings for a steady needle: median of the last few pitches, and a jump of more
 * than a semitone from it restarts the history (a new note was played).
 */
export class PitchSmoother {
  private hist: number[] = []

  constructor(private size = 5) {}

  push(hz: number): number {
    const m = this.value()
    if (m !== null && Math.abs(1200 * Math.log2(hz / m)) > 100) this.hist = []
    this.hist.push(hz)
    if (this.hist.length > this.size) this.hist.shift()
    return this.value()!
  }

  value(): number | null {
    if (!this.hist.length) return null
    const s = [...this.hist].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  reset(): void {
    this.hist = []
  }
}
