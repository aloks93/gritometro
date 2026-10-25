import type { Player, Team } from '../players/players'

/** sustain = longest scream; like silence, its value is seconds */
export type TurnKind = 'scream' | 'silence' | 'sustain'

export interface Turn {
  playerId: string
  teamId?: string
  kind: TurnKind
  /** Context shown above the player, e.g. "Semifinal · Partido 1" */
  label?: string
  /** Score to aim for (precision modes): closer is better, not louder */
  target?: number
}

export interface TurnResult {
  playerId: string
  /** Points for scream turns, seconds for silence and sustain turns */
  value: number
}

export interface Standing {
  id: string
  name: string
  value: number
  display: string
  color?: string
}

export interface ConfigField {
  key: string
  label: string
  min: number
  max: number
  step?: number
}

export interface GameContext {
  players: Player[]
  teams: Team[]
}

/**
 * Contract every challenge implements. All methods are pure: state in, new state out,
 * so modes are trivially testable and the UI can serialize/restore a game.
 */
export interface GameMode<C extends Record<string, number> = Record<string, number>, S = unknown> {
  id: string
  name: string
  description: string
  emoji: string
  minPlayers: number
  maxPlayers?: number
  usesTeams?: boolean
  turnKind: TurnKind
  configFields: ConfigField[]
  defaultConfig: C
  init(ctx: GameContext, config: C): S
  /** null when the game is over */
  nextTurn(state: S): Turn | null
  applyResult(state: S, result: TurnResult): S
  standings(state: S, ctx: GameContext): Standing[]
  /** Short progress line, e.g. "Ronda 2 de 3" */
  progress(state: S, ctx: GameContext): string
  /** Optional rich view data (bracket, tanks) the UI may render */
  view?(state: S, ctx: GameContext): ModeView
}

export type ModeView =
  | { type: 'bracket'; rounds: { name: string; matches: { a: string; b: string; scoreA?: number; scoreB?: number; winner?: string }[] }[] }
  | { type: 'tanks'; tanks: { id: string; name: string; color: string; fill: number; capacity: number }[] }
  | { type: 'duel'; a: Standing; b: Standing; bestOf: number }

export type AnyGameMode = GameMode<Record<string, number>, any>

export function playerName(ctx: GameContext, id: string): string {
  return ctx.players.find((p) => p.id === id)?.name ?? '?'
}

export function fmtPoints(v: number): string {
  return `${v.toFixed(1)} pts`
}

export function fmtSeconds(v: number): string {
  return `${v.toFixed(1)} s`
}
