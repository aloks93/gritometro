import type { TakeMetrics } from './analysis'
import type { MicCandidate } from './studio'

// "Best mic for what?": the same measurements weighted differently per use. A shout needs
// headroom, a podcast needs low hiss, singing needs air… Scores are 0–100 and explainable.

export type ScenarioId = 'speech' | 'singing' | 'shout' | 'podcast' | 'instrument' | 'room'

type FactorKey = 'snr' | 'noise' | 'level' | 'headroom' | 'clipping' | 'tone' | 'low' | 'air' | 'dynamics'

export interface Scenario {
  id: ScenarioId
  name: string
  /** Points per factor; they add up to 100 */
  weights: Partial<Record<FactorKey, number>>
  /** Spectral centroid that sounds right for this use, Hz */
  centroid: [number, number]
  /** Max share of energy under 250 Hz before it sounds boomy */
  maxLow: number
  /** Min share above 4 kHz for presence/air */
  minHigh: number
  /** Wanted crest factor range (dynamics), dB */
  crest: [number, number]
}

export const SCENARIOS: Scenario[] = [
  { id: 'speech', name: 'Voz hablada', weights: { snr: 30, noise: 10, level: 10, clipping: 10, tone: 20, low: 10, air: 10 }, centroid: [1200, 3000], maxLow: 0.4, minHigh: 0.04, crest: [10, 22] },
  { id: 'singing', name: 'Canto', weights: { snr: 25, level: 10, headroom: 15, clipping: 10, tone: 10, low: 5, air: 15, dynamics: 10 }, centroid: [1500, 4000], maxLow: 0.35, minHigh: 0.08, crest: [12, 24] },
  { id: 'shout', name: 'Gritos (Gritómetro)', weights: { snr: 15, level: 10, headroom: 35, clipping: 30, tone: 5, low: 5 }, centroid: [1000, 4000], maxLow: 0.45, minHigh: 0.02, crest: [8, 26] },
  { id: 'podcast', name: 'Podcast / radio', weights: { snr: 25, noise: 25, level: 10, clipping: 10, tone: 15, low: 10, air: 5 }, centroid: [1000, 2800], maxLow: 0.45, minHigh: 0.03, crest: [8, 18] },
  { id: 'instrument', name: 'Instrumento', weights: { snr: 25, level: 10, headroom: 15, clipping: 15, air: 15, dynamics: 20 }, centroid: [800, 5000], maxLow: 0.6, minHigh: 0.06, crest: [14, 30] },
  { id: 'room', name: 'Ambiente / sala', weights: { snr: 15, noise: 35, level: 10, clipping: 10, air: 15, dynamics: 15 }, centroid: [500, 6000], maxLow: 0.6, minHigh: 0.06, crest: [12, 30] }
]

const FACTOR_LABEL: Record<FactorKey, string> = {
  snr: 'Señal/ruido',
  noise: 'Ruido de fondo',
  level: 'Nivel',
  headroom: 'Margen',
  clipping: 'Saturación',
  tone: 'Tono',
  low: 'Graves',
  air: 'Brillo',
  dynamics: 'Dinámica'
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/** 1 inside [lo, hi], falling to 0 one octave outside it */
function inBand(v: number, [lo, hi]: [number, number]): number {
  if (v <= 0) return 0
  if (v < lo) return clamp01(1 - Math.log2(lo / v))
  if (v > hi) return clamp01(1 - Math.log2(v / hi))
  return 1
}

/** 0..1 per factor, with the reason when it falls short */
function factor(key: FactorKey, m: TakeMetrics, s: Scenario): { v: number; note?: string } {
  switch (key) {
    case 'snr': {
      const v = clamp01((m.snrDb - 15) / 35)
      return { v, note: v < 0.5 ? `SNR ${m.snrDb} dB: se oye el ruido` : undefined }
    }
    case 'noise': {
      // A-weighted when available: that's the hiss the ear actually hears
      const n = m.noiseADb ?? m.noiseFloorDb
      const v = clamp01((-45 - n) / 30)
      return { v, note: v < 0.5 ? `Ruido de fondo ${n} dBFS` : undefined }
    }
    case 'level': {
      const dist = m.levelDb < -30 ? -30 - m.levelDb : m.levelDb > -12 ? m.levelDb + 12 : 0
      const v = clamp01(1 - dist / 18)
      return { v, note: v < 0.6 ? (m.levelDb < -30 ? 'Nivel bajo' : 'Nivel muy alto') : undefined }
    }
    case 'headroom': {
      const peak = m.truePeakDb ?? m.peakDb
      const v = clamp01((-1 - peak) / 9)
      return { v, note: v < 0.5 ? `Solo ${(-peak).toFixed(1)} dB de margen` : undefined }
    }
    case 'clipping': {
      const clips = m.clipCount + (m.clippedSamples ? 1 : 0)
      const v = clips === 0 ? 1 : m.clipCount < 5 ? 0.4 : 0
      return { v, note: clips ? 'Saturó' : undefined }
    }
    case 'tone': {
      const v = inBand(m.centroidHz, s.centroid)
      return { v, note: v < 0.6 ? (m.centroidHz < s.centroid[0] ? 'Suena oscuro para este uso' : 'Suena chillón para este uso') : undefined }
    }
    case 'low': {
      const v = m.bands.low <= s.maxLow ? 1 : clamp01(1 - (m.bands.low - s.maxLow) / 0.25)
      return { v, note: v < 0.6 ? 'Demasiados graves' : undefined }
    }
    case 'air': {
      const v = m.bands.high >= s.minHigh ? 1 : clamp01(m.bands.high / s.minHigh)
      return { v, note: v < 0.6 ? 'Le faltan agudos' : undefined }
    }
    case 'dynamics': {
      const [lo, hi] = s.crest
      const c = m.crestDb
      const v = c >= lo && c <= hi ? 1 : clamp01(1 - (c < lo ? lo - c : c - hi) / 8)
      return { v, note: v < 0.6 ? (c < lo ? 'Suena comprimido' : 'Picos muy por encima del promedio') : undefined }
    }
  }
}

export interface ScenarioScore {
  total: number
  parts: { key: FactorKey; label: string; points: number; max: number }[]
  notes: string[]
}

export function scenarioScore(m: TakeMetrics, id: ScenarioId): ScenarioScore {
  const s = SCENARIOS.find((x) => x.id === id) ?? SCENARIOS[0]
  const parts: ScenarioScore['parts'] = []
  const notes: string[] = []
  for (const [key, max] of Object.entries(s.weights) as [FactorKey, number][]) {
    const f = factor(key, m, s)
    parts.push({ key, label: FACTOR_LABEL[key], points: Math.round(f.v * max * 10) / 10, max })
    if (f.note) notes.push(f.note)
  }
  // Hum and DC offset are faults whatever the use
  let total = parts.reduce((a, p) => a + p.points, 0)
  if (m.hum) {
    total -= 8
    notes.push(`Zumbido de ${m.hum.hz} Hz`)
  }
  if (m.dcOffset !== undefined && Math.abs(m.dcOffset) > 0.01) {
    total -= 4
    notes.push('DC offset')
  }
  return { total: Math.max(0, Math.round(total)), parts, notes }
}

export interface ScenarioWinner {
  scenario: Scenario
  best: MicCandidate
  score: number
  /** Points over the runner-up (null with a single mic) */
  margin: number | null
}

/** Ranking for one use, best first */
export function rankForScenario(candidates: MicCandidate[], id: ScenarioId): { c: MicCandidate; score: ScenarioScore }[] {
  return candidates
    .filter((c) => c.metrics)
    .map((c) => ({ c, score: scenarioScore(c.metrics!, id) }))
    .sort((a, b) => b.score.total - a.score.total)
}

export function winnersByScenario(candidates: MicCandidate[]): ScenarioWinner[] {
  const out: ScenarioWinner[] = []
  for (const s of SCENARIOS) {
    const r = rankForScenario(candidates, s.id)
    if (r.length === 0) continue
    out.push({ scenario: s, best: r[0].c, score: r[0].score.total, margin: r[1] ? r[0].score.total - r[1].score.total : null })
  }
  return out
}

/**
 * Output of each mic relative to the reference, in dB, with the trim difference removed.
 * Only meaningful when all takes used the same source at the same distance and level.
 */
export function relativeSensitivity(c: MicCandidate, ref: MicCandidate): number | null {
  if (!c.metrics || !ref.metrics) return null
  return Math.round((c.metrics.levelDb - c.gainDb - (ref.metrics.levelDb - ref.gainDb)) * 10) / 10
}

/** RMS difference between two normalized response curves, dB: 0 = identical tone */
export function curveDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2
  return Math.round(Math.sqrt(s / n) * 10) / 10
}

/** One line per use, for reports: "Voz hablada: SM58 (82, +6)" */
export function scenarioSummary(candidates: MicCandidate[]): string[] {
  return winnersByScenario(candidates).map((w) => `${w.scenario.name}: ${w.best.name} (${w.score}/100${w.margin === null ? '' : w.margin === 0 ? ', empate' : `, +${w.margin}`})`)
}
