import type { GameMode, Standing } from '../GameMode'
import { playerName } from '../GameMode'
import { shuffle } from '../../players/players'

export interface TargetState {
  order: string[]
  rounds: number
  /** Target score for each turn, decided up front so every turn is reproducible */
  targets: number[]
  /** Distance to the target per turn, by player */
  misses: Record<string, number[]>
  turnIndex: number
}

type TargetConfig = { rounds: number; minTarget: number; maxTarget: number }

export function avgMiss(misses: number[]): number {
  return misses.length ? misses.reduce((a, b) => a + b, 0) / misses.length : Infinity
}

/** Precision instead of power: scream as close as possible to the target score */
export function createTargetMode(rand: () => number = Math.random): GameMode<TargetConfig, TargetState> {
  return {
    id: 'target',
    name: 'Puntería',
    description: '¡No gana el más fuerte! Cada turno sale una meta y hay que gritar lo más cerca posible de ella.',
    emoji: '🎯',
    minPlayers: 1,
    turnKind: 'scream',
    configFields: [
      { key: 'rounds', label: 'Rondas', min: 1, max: 5 },
      { key: 'minTarget', label: 'Meta mínima (pts)', min: 10, max: 80, step: 5 },
      { key: 'maxTarget', label: 'Meta máxima (pts)', min: 30, max: 100, step: 5 }
    ],
    defaultConfig: { rounds: 2, minTarget: 30, maxTarget: 85 },

    init(ctx, config) {
      const ids = ctx.players.map((p) => p.id)
      const rounds = Math.max(1, Math.round(config.rounds))
      const lo = Math.min(config.minTarget, config.maxTarget)
      const hi = Math.max(config.minTarget, config.maxTarget)
      // Rounded to 5 so the goal is easy to read and say out loud
      const targets = Array.from({ length: ids.length * rounds }, () => Math.round((lo + rand() * (hi - lo)) / 5) * 5)
      return { order: shuffle(ids, rand), rounds, targets, misses: Object.fromEntries(ids.map((id) => [id, []])), turnIndex: 0 }
    },

    nextTurn(s) {
      const n = s.order.length
      if (n === 0 || s.turnIndex >= n * s.rounds) return null
      const round = Math.floor(s.turnIndex / n) + 1
      const target = s.targets[s.turnIndex]
      return {
        playerId: s.order[s.turnIndex % n],
        kind: 'scream',
        target,
        label: s.rounds > 1 ? `Ronda ${round} de ${s.rounds}` : undefined
      }
    },

    applyResult(s, r) {
      const miss = Math.round(Math.abs(r.value - s.targets[s.turnIndex]) * 10) / 10
      return {
        ...s,
        misses: { ...s.misses, [r.playerId]: [...(s.misses[r.playerId] ?? []), miss] },
        turnIndex: s.turnIndex + 1
      }
    },

    standings(s, ctx): Standing[] {
      return s.order
        .filter((id) => s.misses[id]?.length)
        .map((id) => {
          const avg = avgMiss(s.misses[id])
          // Higher value = better, so the shared podium/sorting logic works unchanged
          return { id, name: playerName(ctx, id), value: -avg, display: avg === 0 ? '¡En el blanco!' : `a ${avg.toFixed(1)} pts de la meta` }
        })
        .sort((a, b) => b.value - a.value)
    },

    progress(s) {
      const total = s.order.length * s.rounds
      return `Turno ${Math.min(s.turnIndex + 1, total)} de ${total}`
    }
  }
}

export const targetMode = createTargetMode()
