import type { GameMode, GameContext, Standing, TurnKind } from '../GameMode'
import { playerName } from '../GameMode'
import { shuffle } from '../../players/players'

export interface AttemptsState {
  order: string[]
  attempts: number
  scores: Record<string, number[]>
  turnIndex: number
}

type AttemptsConfig = { attempts: number; shuffle: number }

/** Shared engine for "everyone gets N tries, best one counts" modes */
export function createAttemptsMode(def: {
  id: string
  name: string
  description: string
  emoji: string
  turnKind: TurnKind
  format: (v: number) => string
}): GameMode<AttemptsConfig, AttemptsState> {
  return {
    ...def,
    minPlayers: 1,
    configFields: [
      { key: 'attempts', label: 'Intentos por jugador', min: 1, max: 5 },
      { key: 'shuffle', label: 'Orden aleatorio (1 = sí)', min: 0, max: 1 }
    ],
    defaultConfig: { attempts: 1, shuffle: 0 },

    init(ctx: GameContext, config) {
      const ids = ctx.players.map((p) => p.id)
      return {
        order: config.shuffle ? shuffle(ids) : ids,
        attempts: Math.max(1, Math.round(config.attempts)),
        scores: Object.fromEntries(ids.map((id) => [id, []])),
        turnIndex: 0
      }
    },

    nextTurn(s) {
      const n = s.order.length
      if (n === 0 || s.turnIndex >= n * s.attempts) return null
      const round = Math.floor(s.turnIndex / n) + 1
      return {
        playerId: s.order[s.turnIndex % n],
        kind: def.turnKind,
        label: s.attempts > 1 ? `Intento ${round} de ${s.attempts}` : undefined
      }
    },

    applyResult(s, r) {
      return {
        ...s,
        scores: { ...s.scores, [r.playerId]: [...(s.scores[r.playerId] ?? []), r.value] },
        turnIndex: s.turnIndex + 1
      }
    },

    standings(s, ctx): Standing[] {
      return s.order
        .filter((id) => s.scores[id]?.length)
        .map((id) => {
          const best = Math.max(...s.scores[id])
          return { id, name: playerName(ctx, id), value: best, display: def.format(best) }
        })
        .sort((a, b) => b.value - a.value)
    },

    progress(s) {
      const total = s.order.length * s.attempts
      return `Turno ${Math.min(s.turnIndex + 1, total)} de ${total}`
    }
  }
}
