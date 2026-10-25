import type { AnyGameMode } from './GameMode'
import { duelMode } from './modes/duel'
import { rankingMode } from './modes/ranking'
import { silenceMode } from './modes/silence'
import { teamTankMode } from './modes/teamTank'
import { tournamentMode } from './modes/tournament'

// To add a challenge: create modes/<id>.ts implementing GameMode and list it here.
export const gameModes: AnyGameMode[] = [rankingMode, duelMode, tournamentMode, teamTankMode, silenceMode]

export function getMode(id: string): AnyGameMode | undefined {
  return gameModes.find((m) => m.id === id)
}
