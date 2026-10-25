import type { GameMode, Standing } from '../GameMode'
import { fmtPoints, playerName } from '../GameMode'

export interface EliminationState {
  alive: string[]
  round: number
  /** Scores of the round in progress */
  pending: Record<string, number>
  /** Eliminated players, in the order they went out */
  out: { id: string; round: number; score: number }[]
  /** Best score per player; absent until they've screamed */
  best: Record<string, number>
}

export const eliminationMode: GameMode<Record<string, never>, EliminationState> = {
  id: 'elimination',
  name: 'Eliminación',
  description: 'Cada ronda gritan todos y el grito más flojito queda fuera. ¡El último en pie gana!',
  emoji: '💥',
  minPlayers: 3,
  turnKind: 'scream',
  configFields: [],
  defaultConfig: {},

  init(ctx) {
    const ids = ctx.players.map((p) => p.id)
    return { alive: ids, round: 1, pending: {}, out: [], best: {} }
  },

  nextTurn(s) {
    if (s.alive.length <= 1) return null
    const playerId = s.alive.find((id) => s.pending[id] === undefined)!
    return { playerId, kind: 'scream', label: `Ronda ${s.round} · quedan ${s.alive.length}` }
  },

  applyResult(s, r) {
    const pending = { ...s.pending, [r.playerId]: r.value }
    const best = { ...s.best, [r.playerId]: Math.max(s.best[r.playerId] ?? 0, r.value) }
    if (s.alive.some((id) => pending[id] === undefined)) return { ...s, pending, best }

    const min = Math.min(...s.alive.map((id) => pending[id]))
    const losers = s.alive.filter((id) => pending[id] === min)
    // Everyone tied: nobody goes out, the round is replayed
    if (losers.length === s.alive.length) return { ...s, pending: {}, best, round: s.round + 1 }
    return {
      ...s,
      alive: s.alive.filter((id) => !losers.includes(id)),
      out: [...s.out, ...losers.map((id) => ({ id, round: s.round, score: pending[id] }))],
      pending: {},
      best,
      round: s.round + 1
    }
  },

  standings(s, ctx): Standing[] {
    const done = s.alive.length <= 1
    const alive = [...s.alive]
      .sort((a, b) => (s.best[b] ?? 0) - (s.best[a] ?? 0))
      .map((id) => ({
        id,
        name: playerName(ctx, id),
        value: 1000 + (s.best[id] ?? 0),
        display:
          s.best[id] === undefined
            ? 'En juego'
            : `${done ? 'Campeón' : 'En juego'} · mejor ${fmtPoints(s.best[id])}`
      }))
    const out = [...s.out].reverse().map((o) => ({
      id: o.id,
      name: playerName(ctx, o.id),
      value: o.round,
      display: `Fuera en ronda ${o.round} (${fmtPoints(o.score)})`
    }))
    return [...alive, ...out]
  },

  progress(s) {
    return s.alive.length <= 1 ? 'Eliminación terminada' : `Ronda ${s.round} · quedan ${s.alive.length}`
  }
}
