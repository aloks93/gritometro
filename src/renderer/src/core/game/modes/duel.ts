import type { GameMode, Standing } from '../GameMode'
import { playerName } from '../GameMode'

export interface DuelState {
  a: string
  b: string
  bestOf: number
  wins: Record<string, number>
  round: number
  pending: Record<string, number>
  totals: Record<string, number>
}

function needed(s: DuelState): number {
  return Math.floor(s.bestOf / 2) + 1
}

function finished(s: DuelState): boolean {
  return s.wins[s.a] >= needed(s) || s.wins[s.b] >= needed(s)
}

export const duelMode: GameMode<{ bestOf: number }, DuelState> = {
  id: 'duel',
  name: 'Duelo 1 vs 1',
  description: 'Dos rivales cara a cara. Gana quien se lleve más rondas.',
  emoji: '⚔️',
  minPlayers: 2,
  maxPlayers: 2,
  turnKind: 'scream',
  configFields: [{ key: 'bestOf', label: 'Al mejor de (rondas)', min: 1, max: 7, step: 2 }],
  defaultConfig: { bestOf: 3 },

  init(ctx, config) {
    const [a, b] = ctx.players.map((p) => p.id)
    const bestOf = Math.max(1, Math.round(config.bestOf) | 1)
    return { a, b, bestOf, wins: { [a]: 0, [b]: 0 }, round: 1, pending: {}, totals: { [a]: 0, [b]: 0 } }
  },

  nextTurn(s) {
    if (finished(s)) return null
    // Alternate who goes first each round so nobody always has the advantage
    const first = s.round % 2 === 1 ? s.a : s.b
    const second = first === s.a ? s.b : s.a
    const playerId = s.pending[first] === undefined ? first : second
    return { playerId, kind: 'scream', label: `Ronda ${s.round}` }
  },

  applyResult(s, r) {
    const pending = { ...s.pending, [r.playerId]: r.value }
    const totals = { ...s.totals, [r.playerId]: s.totals[r.playerId] + r.value }
    if (pending[s.a] === undefined || pending[s.b] === undefined) return { ...s, pending, totals }
    const wins = { ...s.wins }
    if (pending[s.a] > pending[s.b]) wins[s.a]++
    else if (pending[s.b] > pending[s.a]) wins[s.b]++
    // A tie replays the round: the round counter still advances so the order alternates
    return { ...s, wins, totals, pending: {}, round: s.round + 1 }
  },

  standings(s, ctx): Standing[] {
    return [s.a, s.b]
      .map((id) => ({
        id,
        name: playerName(ctx, id),
        value: s.wins[id] * 10000 + s.totals[id],
        display: `${s.wins[id]} ${s.wins[id] === 1 ? 'ronda' : 'rondas'}`
      }))
      .sort((x, y) => y.value - x.value)
  },

  progress(s) {
    return finished(s) ? 'Duelo terminado' : `Ronda ${s.round} · al mejor de ${s.bestOf}`
  },

  view(s, ctx) {
    const mk = (id: string): Standing => ({
      id,
      name: playerName(ctx, id),
      value: s.wins[id],
      display: String(s.wins[id])
    })
    return { type: 'duel', a: mk(s.a), b: mk(s.b), bestOf: s.bestOf }
  }
}
