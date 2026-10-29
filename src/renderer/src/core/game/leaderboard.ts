import { normalizeCode } from '../players/roster'
import type { Player } from '../players/players'

/** Funny rank for a scream, on the 0–100 score scale (min = lowest score that earns it) */
export interface ScreamTitle {
  min: number
  emoji: string
  label: string
}

// Ends are narrower on purpose: nobody wants "pañal mojado", and the top one should be rare
export const SCREAM_TITLES: ScreamTitle[] = [
  { min: 0, emoji: '🍼', label: 'Susto de pañal mojado' },
  { min: 15, emoji: '🦟', label: 'Asustador de mosquitos' },
  { min: 25, emoji: '🐔', label: 'Gallina con credencial' },
  { min: 35, emoji: '🚪', label: 'Espantador de puertas' },
  { min: 45, emoji: '🥴', label: 'Monstruo con hipo' },
  { min: 55, emoji: '😱', label: 'Rompetímpanos profesional' },
  { min: 65, emoji: '🚨', label: 'Peligro para los vecinos' },
  { min: 75, emoji: '💥', label: 'Destructor de puertas' },
  { min: 85, emoji: '⚡', label: 'Generador de apagones' },
  { min: 95, emoji: '🏆', label: '¡Sullivan, entregá tu puesto!' }
]

export function screamTitle(score: number): ScreamTitle {
  let title = SCREAM_TITLES[0]
  for (const t of SCREAM_TITLES) if (score >= t.min) title = t
  return title
}

/** The part of a saved scream the ranking needs */
export interface ScoreRecord {
  playerId: string
  playerCode?: string
  playerName: string
  score: number
  modeId: string
}

export interface LeaderEntry {
  /** Badge code when known (survives re-importing the guest list), else the player id */
  key: string
  playerId: string
  name: string
  score: number
}

// Aiming at a target is about control, not power: those screams don't rank
const UNRANKED_MODES = new Set(['target'])

/** Best scream per player, highest first; each player appears once */
export function topScreamers(records: ScoreRecord[], players: Player[], limit = 10): LeaderEntry[] {
  const byId = new Map(players.map((p) => [p.id, p]))
  const byCode = new Map(players.filter((p) => normalizeCode(p.code)).map((p) => [normalizeCode(p.code), p]))
  const best = new Map<string, LeaderEntry>()
  for (const r of records) {
    if (UNRANKED_MODES.has(r.modeId)) continue
    // A badge re-imported under a new player id still counts as the same person
    const player = byId.get(r.playerId) ?? byCode.get(normalizeCode(r.playerCode))
    const code = normalizeCode(player?.code ?? r.playerCode)
    const key = code ? `c:${code}` : `p:${r.playerId}`
    const prev = best.get(key)
    if (!prev || r.score > prev.score) best.set(key, { key, playerId: player?.id ?? r.playerId, name: player?.name ?? r.playerName, score: r.score })
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
