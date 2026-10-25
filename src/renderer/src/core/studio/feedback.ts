// Feedback (howl) detector: a feedback tone is a narrow spectral peak that stands far above
// its neighbours and stays at the same frequency. Voices move and are broad; hum is low.

export interface FeedbackCandidate {
  hz: number
  /** Level of the peak, dBFS per bin */
  db: number
  /** How far it stands above the surrounding bins */
  prominenceDb: number
  /** Time it has been sustained, ms */
  sustainedMs: number
}

interface Track {
  bin: number
  db: number
  prominence: number
  since: number
  lastSeen: number
}

export interface FeedbackOptions {
  /** Minimum height above the local median, dB */
  prominenceDb: number
  /** Must stay this long to be reported */
  sustainMs: number
  /** Peaks quieter than this are ignored */
  minDb: number
  minHz: number
  maxHz: number
}

export const DEFAULT_FEEDBACK_OPTIONS: FeedbackOptions = { prominenceDb: 18, sustainMs: 600, minDb: -70, minHz: 120, maxHz: 12000 }

export class FeedbackDetector {
  private tracks: Track[] = []
  constructor(private opts: FeedbackOptions = DEFAULT_FEEDBACK_OPTIONS) {}

  /** Feeds one spectrum (dB per bin) at time `t` ms; returns the confirmed feedback tones */
  push(db: ArrayLike<number>, sampleRate: number, fftSize: number, t: number): FeedbackCandidate[] {
    const hzPerBin = sampleRate / fftSize
    const lo = Math.max(3, Math.floor(this.opts.minHz / hzPerBin))
    const hi = Math.min(db.length - 12, Math.ceil(this.opts.maxHz / hzPerBin))
    const peaks: { bin: number; db: number; prominence: number }[] = []
    for (let i = lo; i <= hi; i++) {
      const v = db[i]
      if (v < this.opts.minDb || v < db[i - 1] || v < db[i + 1]) continue
      // Local median of bins 4–12 away on both sides: a pure tone's skirt is excluded
      const around: number[] = []
      for (let d = 4; d <= 12; d++) around.push(db[i - d], db[i + d])
      around.sort((a, b) => a - b)
      const median = (around[8] + around[9]) / 2
      const prominence = v - median
      if (prominence >= this.opts.prominenceDb) peaks.push({ bin: i, db: v, prominence })
    }
    // Keep the strongest few so a noisy frame can't explode the track list
    peaks.sort((a, b) => b.prominence - a.prominence)
    const next: Track[] = []
    for (const p of peaks.slice(0, 8)) {
      const prev = this.tracks.find((tr) => Math.abs(tr.bin - p.bin) <= 1)
      next.push({ bin: p.bin, db: p.db, prominence: p.prominence, since: prev ? prev.since : t, lastSeen: t })
    }
    // A track survives one missed frame (analyser jitter)
    for (const tr of this.tracks) if (!next.some((n) => Math.abs(n.bin - tr.bin) <= 1) && t - tr.lastSeen < 250) next.push(tr)
    this.tracks = next
    return this.tracks
      .filter((tr) => tr.lastSeen === t && t - tr.since >= this.opts.sustainMs)
      .map((tr) => ({ hz: Math.round(tr.bin * hzPerBin), db: round1(tr.db), prominenceDb: round1(tr.prominence), sustainedMs: Math.round(t - tr.since) }))
  }

  reset(): void {
    this.tracks = []
  }
}

/** Merges a new notch frequency into a list, ignoring ones within a third of a semitone */
export function addNotch(list: { hz: number; gainDb: number; q: number }[], hz: number, max = 6): { hz: number; gainDb: number; q: number }[] {
  if (list.some((n) => Math.abs(1200 * Math.log2(n.hz / hz)) < 33)) return list
  const next = [...list, { hz: Math.round(hz), gainDb: -12, q: 30 }]
  return next.slice(-max)
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
