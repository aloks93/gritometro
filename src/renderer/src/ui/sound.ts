import { useMemo } from 'react'
import type { SoundStyle, Theme } from '../themes/Theme'
import { useStore } from './store'

// Synthesized effects (no asset files). User-uploaded sounds in a theme override win/record.

let ctx: AudioContext | null = null
function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', gain = 0.12, freqEnd?: number): void {
  const c = ac()
  const t0 = c.currentTime + start
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (freqEnd) osc.frequency.linearRampToValueAtTime(freqEnd, t0 + dur)
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)
}

function playUrl(url: string): void {
  const audio = new Audio(url)
  audio.play().catch(() => undefined)
}

const synth = {
  tick: () => tone(660, 0, 0.12, 'square', 0.1),
  go: () => tone(990, 0, 0.18, 'square', 0.14),
  result: (style: SoundStyle) =>
    style === 'factory'
      ? [0, 0.1, 0.2].forEach((s, i) => tone(300 + i * 150, s, 0.12, 'sawtooth', 0.08))
      : [0, 0.08].forEach((s, i) => tone(523 + i * 260, s, 0.12, 'triangle', 0.12)),
  record: (style: SoundStyle) => {
    if (style === 'factory') {
      // Factory alarm siren
      for (let i = 0; i < 4; i++) {
        tone(500, i * 0.5, 0.25, 'sawtooth', 0.09, 900)
        tone(900, i * 0.5 + 0.25, 0.25, 'sawtooth', 0.09, 500)
      }
    } else {
      ;[523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.2, 'square', 0.1))
    }
  },
  win: (style: SoundStyle) => {
    const notes = style === 'factory' ? [392, 523, 659, 784, 659, 784, 1047] : [523, 659, 784, 1047, 784, 1047]
    notes.forEach((f, i) => tone(f, i * 0.14, 0.22, 'triangle', 0.14))
  },
  /** "Happy Birthday to You" (public domain melody), music-box style */
  birthday: () => {
    const N: Record<string, number> = { G4: 392, A4: 440, B4: 494, C5: 523, D5: 587, E5: 659, F5: 698, G5: 784 }
    // [note, beats] at 3/4; the pickup notes are dotted-eighth + sixteenth
    const song: [string, number][] = [
      ['G4', 0.75], ['G4', 0.25], ['A4', 1], ['G4', 1], ['C5', 1], ['B4', 2],
      ['G4', 0.75], ['G4', 0.25], ['A4', 1], ['G4', 1], ['D5', 1], ['C5', 2],
      ['G4', 0.75], ['G4', 0.25], ['G5', 1], ['E5', 1], ['C5', 1], ['B4', 1], ['A4', 2],
      ['F5', 0.75], ['F5', 0.25], ['E5', 1], ['C5', 1], ['D5', 1], ['C5', 3]
    ]
    const beat = 0.42
    let t = 0
    for (const [note, beats] of song) {
      const dur = beats * beat
      tone(N[note], t, dur * 0.95, 'triangle', 0.13)
      tone(N[note] * 2, t, dur * 0.5, 'sine', 0.03)
      t += dur
    }
  }
}

export interface Sounds {
  tick: () => void
  go: () => void
  result: () => void
  record: () => void
  win: () => void
  birthday: () => void
}

export function makeSounds(theme: Theme, enabled: boolean): Sounds {
  const guard = (fn: () => void) => () => {
    if (!enabled) return
    try {
      fn()
    } catch {
      /* audio output unavailable */
    }
  }
  return {
    tick: guard(synth.tick),
    go: guard(synth.go),
    result: guard(() => synth.result(theme.soundStyle)),
    record: guard(() => (theme.sounds.record ? playUrl(theme.sounds.record) : synth.record(theme.soundStyle))),
    win: guard(() => (theme.sounds.win ? playUrl(theme.sounds.win) : synth.win(theme.soundStyle))),
    birthday: guard(synth.birthday)
  }
}

export function useSounds(): Sounds {
  const { theme, data } = useStore()
  return useMemo(() => makeSounds(theme, data.settings.soundEnabled), [theme, data.settings.soundEnabled])
}
