export interface AvatarSpec {
  hue: number
  eyes: 1 | 2 | 3
  horns: boolean
  fur: boolean
  spots: boolean
  mouth: 'grin' | 'fangs' | 'open'
}

export interface Player {
  id: string
  name: string
  age?: number
  avatar: AvatarSpec
  /** Optional photo/drawing uploaded by the user, data URL */
  photo?: string
}

export interface Team {
  id: string
  name: string
  color: string
  playerIds: string[]
}

export interface HandicapRule {
  maxAge: number
  multiplier: number
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function randomAvatar(rand: () => number = Math.random): AvatarSpec {
  const mouths: AvatarSpec['mouth'][] = ['grin', 'fangs', 'open']
  return {
    hue: Math.floor(rand() * 360),
    eyes: (1 + Math.floor(rand() * 3)) as AvatarSpec['eyes'],
    horns: rand() > 0.5,
    fur: rand() > 0.5,
    spots: rand() > 0.6,
    mouth: mouths[Math.floor(rand() * mouths.length)]
  }
}

export function createPlayer(name: string, age?: number): Player {
  return { id: newId('p'), name: name.trim(), age, avatar: randomAvatar() }
}

/** Multiplier for the youngest matching rule; rules are evaluated by ascending maxAge */
export function handicapFor(age: number | undefined, rules: HandicapRule[], enabled: boolean): number {
  if (!enabled || age === undefined) return 1
  const rule = [...rules].sort((a, b) => a.maxAge - b.maxAge).find((r) => age <= r.maxAge)
  return rule?.multiplier ?? 1
}

export const TEAM_COLORS = ['#3fd0c9', '#a3e635', '#c084fc', '#fb923c']
export const TEAM_NAMES = ['Equipo Peludo', 'Equipo Un Ojo', 'Equipo Tentáculo', 'Equipo Cuernos']

/** Round-robin distribution: alternates players so teams stay balanced */
export function autoTeams(players: Player[], count: number): Team[] {
  const teams: Team[] = Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    name: TEAM_NAMES[i] ?? `Equipo ${i + 1}`,
    color: TEAM_COLORS[i % TEAM_COLORS.length],
    playerIds: []
  }))
  players.forEach((p, i) => teams[i % count].playerIds.push(p.id))
  return teams
}

export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
