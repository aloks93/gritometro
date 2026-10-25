import type { GameContext } from '../core/game/GameMode'

export interface GameSession {
  modeId: string
  config: Record<string, number>
  ctx: GameContext
}

export type Route =
  | { name: 'home' }
  | { name: 'players' }
  | { name: 'modes' }
  | { name: 'game'; session: GameSession }
  | { name: 'records' }
  | { name: 'customize' }
  | { name: 'audio' }
  | { name: 'settings' }

export type Navigate = (route: Route) => void
