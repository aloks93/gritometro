import type { CustomTheme, Theme } from './Theme'
import { clasicoTheme } from './clasico'
import { fabricaMonstruosTheme } from './fabrica-monstruos'
import { arcoirisTheme } from './arcoiris'

// To add a theme: create themes/<id>/index.ts exporting a Theme and list it here.
export const builtInThemes: Theme[] = [fabricaMonstruosTheme, clasicoTheme, arcoirisTheme]

export const DEFAULT_THEME_ID = fabricaMonstruosTheme.id

export function getBuiltIn(id: string): Theme {
  return builtInThemes.find((t) => t.id === id) ?? builtInThemes[0]
}

/** Layers a user's overrides on top of its base theme; components always come from the base */
export function resolveTheme(id: string, custom: CustomTheme[]): Theme {
  const c = custom.find((t) => t.id === id)
  if (!c) return getBuiltIn(id)
  const base = getBuiltIn(c.baseId)
  return {
    ...base,
    id: c.id,
    name: c.name,
    tokens: { ...base.tokens, ...c.tokens },
    texts: { ...base.texts, ...c.texts },
    images: { ...base.images, ...c.images },
    sounds: { ...base.sounds, ...c.sounds }
  }
}

export function customFromBuiltIn(theme: Theme, name: string): CustomTheme {
  return {
    id: `custom-${Date.now().toString(36)}`,
    name,
    baseId: theme.id,
    tokens: {},
    texts: {},
    images: {},
    sounds: {}
  }
}

export function isCustomTheme(theme: unknown): theme is CustomTheme {
  if (!theme || typeof theme !== 'object') return false
  const t = theme as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.name === 'string' && typeof t.baseId === 'string' && typeof t.tokens === 'object'
}
