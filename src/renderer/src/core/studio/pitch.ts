// Monophonic pitch detection (YIN) for the voice tuner and the take's median pitch.

export interface PitchResult {
  hz: number
  /** 0..1, how periodic the frame is (1 = pure tone) */
  clarity: number
}

/**
 * YIN (de Cheveigné & Kawahara 2002): cumulative mean normalized difference,
 * absolute threshold and parabolic refinement. null when the frame isn't pitched.
 */
export function detectPitch(
  buf: ArrayLike<number>,
  sampleRate: number,
  minHz = 60,
  maxHz = 1500,
  threshold = 0.15
): PitchResult | null {
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(buf.length / 2))
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz))
  if (maxTau <= minTau + 2) return null
  const w = buf.length - maxTau

  let energy = 0
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i]
  if (energy / buf.length < 1e-7) return null

  const d = new Float64Array(maxTau + 1)
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0
    for (let i = 0; i < w; i++) {
      const diff = buf[i] - buf[i + tau]
      sum += diff * diff
    }
    d[tau] = sum
  }
  // Cumulative mean normalization
  const cmnd = new Float64Array(maxTau + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau]
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1
  }

  let tau = -1
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau < 0) return null

  let refined = tau
  if (tau > 1 && tau < maxTau) {
    const a = cmnd[tau - 1]
    const b = cmnd[tau]
    const c = cmnd[tau + 1]
    const den = a - 2 * b + c
    if (den !== 0) refined = tau + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den))
  }
  const hz = sampleRate / refined
  if (hz < minHz || hz > maxHz) return null
  return { hz, clarity: Math.max(0, Math.min(1, 1 - cmnd[tau])) }
}

const NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']
const LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface NoteInfo {
  /** Scientific name, e.g. "A4" */
  name: string
  /** Solfège name used in Spanish, e.g. "La4" */
  solfege: string
  midi: number
  /** Deviation from the tempered note, −50..+50 */
  cents: number
}

export function noteInfo(hz: number, a4 = 440): NoteInfo {
  const exact = 69 + 12 * Math.log2(hz / a4)
  const midi = Math.round(exact)
  const pc = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  return { name: `${LETTERS[pc]}${octave}`, solfege: `${NAMES[pc]}${octave}`, midi, cents: Math.round((exact - midi) * 100) }
}

/** Median pitch of a recording (frames hop through the PCM), null if mostly unpitched */
export function medianPitch(pcm: Float32Array, sampleRate: number, frame = 2048, hop = 4096): number | null {
  const found: number[] = []
  let frames = 0
  for (let i = 0; i + frame <= pcm.length; i += hop) {
    frames++
    const p = detectPitch(pcm.subarray(i, i + frame), sampleRate)
    if (p && p.clarity > 0.8) found.push(p.hz)
  }
  if (found.length < Math.max(3, frames * 0.1)) return null
  found.sort((a, b) => a - b)
  return Math.round(found[Math.floor(found.length / 2)])
}
