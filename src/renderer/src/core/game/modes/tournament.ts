import type { GameMode, Standing } from '../GameMode'
import { fmtPoints, playerName } from '../GameMode'
import { shuffle } from '../../players/players'

export interface Match {
  a: string | null
  b: string | null
  scoreA?: number
  scoreB?: number
  winner?: string
}

export interface TournamentState {
  rounds: Match[][]
  best: Record<string, number>
}

export function roundName(matchCount: number, index: number): string {
  if (matchCount === 1) return 'Final'
  if (matchCount === 2) return 'Semifinal'
  if (matchCount === 4) return 'Cuartos de final'
  if (matchCount === 8) return 'Octavos de final'
  return `Ronda ${index + 1}`
}

/** Pairs seed i with seed (size-1-i); missing seeds become byes for the top seeds */
export function buildFirstRound(ids: string[]): Match[] {
  let size = 1
  while (size < ids.length) size *= 2
  const slots: (string | null)[] = [...ids, ...Array(size - ids.length).fill(null)]
  const matches: Match[] = []
  for (let i = 0; i < size / 2; i++) {
    const m: Match = { a: slots[i], b: slots[size - 1 - i] }
    if (m.a && !m.b) m.winner = m.a
    matches.push(m)
  }
  return matches
}

function currentMatch(s: TournamentState): { round: number; index: number; match: Match } | null {
  for (let r = 0; r < s.rounds.length; r++) {
    const i = s.rounds[r].findIndex((m) => !m.winner)
    if (i >= 0) return { round: r, index: i, match: s.rounds[r][i] }
  }
  return null
}

function advance(rounds: Match[][]): Match[][] {
  const last = rounds[rounds.length - 1]
  if (last.length === 1 || last.some((m) => !m.winner)) return rounds
  const next: Match[] = []
  for (let i = 0; i < last.length; i += 2) next.push({ a: last[i].winner!, b: last[i + 1].winner! })
  return [...rounds, next]
}

export const tournamentMode: GameMode<{ shuffle: number }, TournamentState> = {
  id: 'tournament',
  name: 'Torneo por llaves',
  description: 'Eliminatorias hasta coronar al campeón del grito. ¡Cada partido es a muerte súbita!',
  emoji: '🥇',
  minPlayers: 2,
  turnKind: 'scream',
  configFields: [{ key: 'shuffle', label: 'Sorteo aleatorio (1 = sí)', min: 0, max: 1 }],
  defaultConfig: { shuffle: 1 },

  init(ctx, config) {
    const ids = ctx.players.map((p) => p.id)
    const ordered = config.shuffle ? shuffle(ids) : ids
    return { rounds: advance([buildFirstRound(ordered)]), best: {} }
  },

  nextTurn(s) {
    const cur = currentMatch(s)
    if (!cur) return null
    const label = `${roundName(s.rounds[cur.round].length, cur.round)} · Partido ${cur.index + 1}`
    const playerId = cur.match.scoreA === undefined ? cur.match.a! : cur.match.b!
    return { playerId, kind: 'scream', label }
  },

  applyResult(s, r) {
    const cur = currentMatch(s)
    if (!cur) return s
    const m: Match = { ...cur.match }
    if (r.playerId === m.a && m.scoreA === undefined) m.scoreA = r.value
    else if (r.playerId === m.b) m.scoreB = r.value
    if (m.scoreA !== undefined && m.scoreB !== undefined) {
      if (m.scoreA === m.scoreB) {
        // Tie: both scream again
        m.scoreA = undefined
        m.scoreB = undefined
      } else {
        m.winner = m.scoreA > m.scoreB ? m.a! : m.b!
      }
    }
    const rounds = s.rounds.map((round, ri) =>
      ri === cur.round ? round.map((x, mi) => (mi === cur.index ? m : x)) : round
    )
    const best = { ...s.best, [r.playerId]: Math.max(s.best[r.playerId] ?? 0, r.value) }
    return { rounds: advance(rounds), best }
  },

  standings(s, ctx): Standing[] {
    // Further round reached = better; champion on top; ties broken by best scream
    const reached: Record<string, number> = {}
    s.rounds.forEach((round, ri) =>
      round.forEach((m) => {
        if (m.a) reached[m.a] = ri
        if (m.b) reached[m.b] = ri
      })
    )
    const final = s.rounds[s.rounds.length - 1]
    const champion = final.length === 1 ? final[0].winner : undefined
    return Object.keys(reached)
      .map((id) => {
        const level = id === champion ? s.rounds.length : reached[id]
        const best = s.best[id] ?? 0
        return {
          id,
          name: playerName(ctx, id),
          value: level * 1000 + best,
          display: id === champion ? '👑 Campeón' : `${roundName(s.rounds[reached[id]].length, reached[id])} · ${fmtPoints(best)}`
        }
      })
      .sort((a, b) => b.value - a.value)
  },

  progress(s) {
    const cur = currentMatch(s)
    if (!cur) return '¡Torneo terminado!'
    return roundName(s.rounds[cur.round].length, cur.round)
  },

  view(s, ctx) {
    const name = (id: string | null): string => (id ? playerName(ctx, id) : '— libre —')
    return {
      type: 'bracket',
      rounds: s.rounds.map((round, ri) => ({
        name: roundName(round.length, ri),
        matches: round.map((m) => ({
          a: name(m.a),
          b: name(m.b),
          scoreA: m.scoreA,
          scoreB: m.scoreB,
          winner: m.winner ? playerName(ctx, m.winner) : undefined
        }))
      }))
    }
  }
}
