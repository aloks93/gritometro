import type { ComponentType, ReactNode } from 'react'

export interface ThemeTokens {
  bg: string
  bgAlt: string
  surface: string
  surfaceBorder: string
  text: string
  textMuted: string
  primary: string
  primaryText: string
  accent: string
  success: string
  danger: string
  meterLow: string
  meterMid: string
  meterHigh: string
  fontDisplay: string
  fontBody: string
  radius: string
}

export interface ScoreLevel {
  /** Minimum score (0–100) for this label */
  min: number
  label: string
}

export interface ThemeTexts {
  appTitle: string
  subtitle: string
  screamCta: string
  silenceCta: string
  getReady: string
  resultTitle: string
  newRecord: string
  winnerTitle: string
  certificateTitle: string
  certificateBody: string
  levels: ScoreLevel[]
}

export interface MeterProps {
  /** Live level 0..1 */
  level: number
  /** Highest level reached this turn 0..1 */
  held: number
  active: boolean
  score?: number | null
  clipped?: boolean
  compact?: boolean
}

export interface RevealProps {
  children: ReactNode
}

/** Optional visual overrides; anything missing falls back to the generic UI component */
export interface ThemeComponents {
  Meter?: ComponentType<MeterProps>
  Background?: ComponentType
  Reveal?: ComponentType<RevealProps>
}

export type SoundStyle = 'arcade' | 'factory'

export interface ThemeImages {
  background?: string
  logo?: string
}

export interface ThemeSounds {
  /** Data URLs of user-provided audio; synthesized sounds are used otherwise */
  win?: string
  record?: string
}

export interface Theme {
  id: string
  name: string
  description: string
  tokens: ThemeTokens
  texts: ThemeTexts
  components: ThemeComponents
  soundStyle: SoundStyle
  images: ThemeImages
  sounds: ThemeSounds
}

/** A user-made theme: overrides layered on top of a built-in base theme (stored as JSON) */
export interface CustomTheme {
  id: string
  name: string
  baseId: string
  tokens: Partial<ThemeTokens>
  texts: Partial<Omit<ThemeTexts, 'levels'>>
  images: ThemeImages
  sounds: ThemeSounds
}

export function levelLabel(theme: Theme, score: number): string {
  const sorted = [...theme.texts.levels].sort((a, b) => b.min - a.min)
  return sorted.find((l) => score >= l.min)?.label ?? sorted[sorted.length - 1]?.label ?? ''
}

export const FONT_OPTIONS = [
  { label: 'Luckiest Guy (caricatura)', value: "'Luckiest Guy', 'Impact', sans-serif" },
  { label: 'Nunito (redondeada)', value: "'Nunito', 'Segoe UI', sans-serif" },
  { label: 'Segoe UI (sistema)', value: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Comic Sans MS', value: "'Comic Sans MS', 'Comic Sans', cursive" },
  { label: 'Impact', value: "Impact, 'Arial Black', sans-serif" },
  { label: 'Courier (máquina)', value: "'Courier New', monospace" }
]

export const TOKEN_LABELS: Partial<Record<keyof ThemeTokens, string>> = {
  bg: 'Fondo',
  bgAlt: 'Fondo secundario',
  text: 'Texto',
  textMuted: 'Texto suave',
  primary: 'Color principal (botones)',
  primaryText: 'Texto de botones',
  accent: 'Acento',
  success: 'Éxito',
  danger: 'Alerta',
  meterLow: 'Medidor bajo',
  meterMid: 'Medidor medio',
  meterHigh: 'Medidor alto'
}
