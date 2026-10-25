import { describe, expect, it } from 'vitest'
import type { AnyGameMode, GameContext } from './GameMode'
import { createPlayer, autoTeams, handicapFor } from '../players/players'
import { rankingMode } from './modes/ranking'
import { duelMode } from './modes/duel'
import { tournamentMode, buildFirstRound } from './modes/tournament'
import { teamTankMode } from './modes/teamTank'
import { silenceMode } from './modes/silence'
import { longestMode } from './modes/longest'
import { gameModes } from './registry'

function ctxOf(n: number, teams = 0): GameContext {
  const players = Array.from({ length: n }, (_, i) => ({ ...createPlayer(`J${i + 1}`), id: `p${i + 1}` }))
  return { players, teams: teams ? autoTeams(players, teams) : [] }
}

/** Plays a mode to the end using a score function; returns final state */
function play(mode: AnyGameMode, ctx: GameContext, config: Record<string, number>, score: (id: string, turn: number) => number) {
  let s = mode.init(ctx, config)
  let turn = 0
  for (let t = mode.nextTurn(s); t; t = mode.nextTurn(s)) {
    s = mode.applyResult(s, { playerId: t.playerId, value: score(t.playerId, turn++) })
    if (turn > 500) throw new Error('el modo no termina')
  }
  return { s, turns: turn }
}

const byPlayer = (id: string): number => Number(id.slice(1)) * 10

describe('registry', () => {
  it('has unique ids', () => {
    const ids = gameModes.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('ranking', () => {
  it('gives each player N attempts and keeps the best', () => {
    const ctx = ctxOf(3)
    const { s, turns } = play(rankingMode, ctx, { attempts: 2, shuffle: 0 }, (id, turn) => byPlayer(id) + turn)
    expect(turns).toBe(6)
    const st = rankingMode.standings(s, ctx)
    expect(st[0].id).toBe('p3')
    expect(st[0].value).toBe(30 + 5)
  })
})

describe('silence', () => {
  it('uses silence turns', () => {
    const ctx = ctxOf(2)
    const s = silenceMode.init(ctx, silenceMode.defaultConfig)
    expect(silenceMode.nextTurn(s)?.kind).toBe('silence')
  })
})

describe('longest scream', () => {
  it('uses sustain turns and the longest hold wins', () => {
    const ctx = ctxOf(3)
    expect(longestMode.nextTurn(longestMode.init(ctx, longestMode.defaultConfig))?.kind).toBe('sustain')
    const { s, turns } = play(longestMode, ctx, { attempts: 2, shuffle: 0 }, (id, turn) => (id === 'p2' && turn === 4 ? 12.3 : 5))
    expect(turns).toBe(6)
    const st = longestMode.standings(s, ctx)
    expect(st[0].id).toBe('p2')
    expect(st[0].display).toBe('12.3 s')
  })
})

describe('duel', () => {
  it('first to 2 wins a best-of-3 and alternates who starts', () => {
    const ctx = ctxOf(2)
    let s = duelMode.init(ctx, { bestOf: 3 })
    expect(duelMode.nextTurn(s)?.playerId).toBe('p1')
    s = duelMode.applyResult(s, { playerId: 'p1', value: 50 })
    s = duelMode.applyResult(s, { playerId: 'p2', value: 60 })
    expect(duelMode.nextTurn(s)?.playerId).toBe('p2')
    const { s: end, turns } = play(duelMode, ctx, { bestOf: 3 }, byPlayer)
    expect(turns).toBe(4)
    expect(duelMode.standings(end, ctx)[0].id).toBe('p2')
  })
  it('replays tied rounds', () => {
    const ctx = ctxOf(2)
    let s = duelMode.init(ctx, { bestOf: 1 })
    s = duelMode.applyResult(s, { playerId: 'p1', value: 50 })
    s = duelMode.applyResult(s, { playerId: 'p2', value: 50 })
    expect(duelMode.nextTurn(s)).not.toBeNull()
  })
})

describe('tournament', () => {
  it('gives byes to top seeds when players are odd', () => {
    const r = buildFirstRound(['a', 'b', 'c', 'd', 'e'])
    expect(r).toHaveLength(4)
    expect(r.filter((m) => m.b === null).map((m) => m.winner)).toEqual(['a', 'b', 'c'])
  })
  it('crowns the loudest player', () => {
    const ctx = ctxOf(5)
    const { s } = play(tournamentMode, ctx, { shuffle: 0 }, byPlayer)
    const st = tournamentMode.standings(s, ctx)
    expect(st[0].id).toBe('p5')
    expect(st[0].display).toContain('Campeón')
    expect(st).toHaveLength(5)
  })
  it('works with exactly two players', () => {
    const ctx = ctxOf(2)
    const { turns } = play(tournamentMode, ctx, { shuffle: 0 }, byPlayer)
    expect(turns).toBe(2)
  })
})

describe('team tank', () => {
  it('finishes the round after a tank fills and the fullest team wins', () => {
    const ctx = ctxOf(4, 2)
    const { s, turns } = play(teamTankMode, ctx, { capacity: 100, maxRounds: 10 }, byPlayer)
    expect(turns % 2).toBe(0)
    const st = teamTankMode.standings(s, ctx)
    expect(st[0].value).toBeGreaterThanOrEqual(100)
  })
  it('stops at max rounds', () => {
    const ctx = ctxOf(4, 2)
    const { turns } = play(teamTankMode, ctx, { capacity: 100000, maxRounds: 3 }, byPlayer)
    expect(turns).toBe(6)
  })
})

describe('handicap', () => {
  const rules = [
    { maxAge: 8, multiplier: 1.15 },
    { maxAge: 5, multiplier: 1.3 }
  ]
  it('picks the youngest matching rule', () => {
    expect(handicapFor(4, rules, true)).toBe(1.3)
    expect(handicapFor(7, rules, true)).toBe(1.15)
    expect(handicapFor(30, rules, true)).toBe(1)
    expect(handicapFor(4, rules, false)).toBe(1)
  })
})
