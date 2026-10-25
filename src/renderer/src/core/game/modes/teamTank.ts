import type { GameMode, Standing } from '../GameMode'

export interface TankState {
  teamIds: string[]
  members: Record<string, string[]>
  fills: Record<string, number>
  turnIndex: number
  capacity: number
  maxRounds: number
}

function finished(s: TankState): boolean {
  const T = s.teamIds.length
  const roundComplete = s.turnIndex % T === 0
  const someoneFull = s.teamIds.some((id) => s.fills[id] >= s.capacity)
  // Finish the round once a tank fills so every team gets the same number of turns
  return (someoneFull && roundComplete) || s.turnIndex >= T * s.maxRounds
}

export const teamTankMode: GameMode<{ capacity: number; maxRounds: number }, TankState> = {
  id: 'team-tank',
  name: 'Tanque por equipos',
  description: 'Cada grito llena el tanque de tu equipo. ¡El primero en llenarlo gana la energía!',
  emoji: '🧪',
  minPlayers: 2,
  usesTeams: true,
  turnKind: 'scream',
  configFields: [
    { key: 'capacity', label: 'Capacidad del tanque (puntos)', min: 50, max: 2000, step: 50 },
    { key: 'maxRounds', label: 'Máximo de rondas', min: 1, max: 30 }
  ],
  defaultConfig: { capacity: 300, maxRounds: 10 },

  init(ctx, config) {
    const teams = ctx.teams.filter((t) => t.playerIds.length > 0)
    return {
      teamIds: teams.map((t) => t.id),
      members: Object.fromEntries(teams.map((t) => [t.id, t.playerIds])),
      fills: Object.fromEntries(teams.map((t) => [t.id, 0])),
      turnIndex: 0,
      capacity: config.capacity,
      maxRounds: config.maxRounds
    }
  },

  nextTurn(s) {
    if (s.teamIds.length === 0 || finished(s)) return null
    const T = s.teamIds.length
    const teamId = s.teamIds[s.turnIndex % T]
    const round = Math.floor(s.turnIndex / T)
    const members = s.members[teamId]
    return { playerId: members[round % members.length], teamId, kind: 'scream', label: `Ronda ${round + 1}` }
  },

  applyResult(s, r) {
    const teamId = s.teamIds[s.turnIndex % s.teamIds.length]
    return { ...s, fills: { ...s.fills, [teamId]: s.fills[teamId] + r.value }, turnIndex: s.turnIndex + 1 }
  },

  standings(s, ctx): Standing[] {
    return s.teamIds
      .map((id) => {
        const team = ctx.teams.find((t) => t.id === id)!
        const fill = Math.round(s.fills[id] * 10) / 10
        return { id, name: team.name, value: fill, display: `${fill} / ${s.capacity}`, color: team.color }
      })
      .sort((a, b) => b.value - a.value)
  },

  progress(s) {
    if (finished(s)) return '¡Tanques cerrados!'
    return `Ronda ${Math.floor(s.turnIndex / s.teamIds.length) + 1} de ${s.maxRounds}`
  },

  view(s, ctx) {
    return {
      type: 'tanks',
      tanks: s.teamIds.map((id) => {
        const team = ctx.teams.find((t) => t.id === id)!
        return { id, name: team.name, color: team.color, fill: s.fills[id], capacity: s.capacity }
      })
    }
  }
}
