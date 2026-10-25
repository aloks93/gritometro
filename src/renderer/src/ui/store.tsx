import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { defaultAudioSettings, type AudioSettings } from '../core/audio/AudioConfig'
import type { Player } from '../core/players/players'
import { defaultGameSettings, type GameSettings } from '../core/settings/settings'
import type { CustomTheme, Theme } from '../themes/Theme'
import { DEFAULT_THEME_ID, resolveTheme } from '../themes/registry'
import { load, save } from './storage'

export interface RecordEntry {
  id: string
  playerId: string
  playerName: string
  score: number
  modeId: string
  date: string
  /** Approximate dB SPL of the sustained peak */
  db?: number
}

export interface AppData {
  settings: GameSettings
  audio: AudioSettings
  players: Player[]
  records: RecordEntry[]
  customThemes: CustomTheme[]
  themeId: string
}

const KEYS: Record<keyof AppData, string> = {
  settings: 'settings',
  audio: 'audio',
  players: 'players',
  records: 'records',
  customThemes: 'custom-themes',
  themeId: 'theme'
}

type Updater<T> = T | ((prev: T) => T)

interface Store {
  data: AppData
  theme: Theme
  update: <K extends keyof AppData>(key: K, value: Updater<AppData[K]>) => void
}

const StoreContext = createContext<Store | null>(null)

async function loadAll(): Promise<AppData> {
  const [settings, audio, players, records, customThemes, themeId] = await Promise.all([
    load<Partial<GameSettings>>(KEYS.settings, {}),
    load<AudioSettings | null>(KEYS.audio, null),
    load<Player[]>(KEYS.players, []),
    load<RecordEntry[]>(KEYS.records, []),
    load<CustomTheme[]>(KEYS.customThemes, []),
    load<string>(KEYS.themeId, DEFAULT_THEME_ID)
  ])
  // Merge with defaults so settings added in newer versions get sane values
  const audioSettings = audio && audio.profiles?.length ? { ...defaultAudioSettings(), ...audio } : defaultAudioSettings()
  return {
    settings: { ...defaultGameSettings(), ...settings },
    audio: audioSettings,
    players,
    records,
    customThemes,
    themeId
  }
}

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element | null {
  const [data, setData] = useState<AppData | null>(null)

  useEffect(() => {
    loadAll().then(setData)
  }, [])

  const update = useCallback(<K extends keyof AppData>(key: K, value: Updater<AppData[K]>) => {
    setData((prev) => {
      if (!prev) return prev
      const next = typeof value === 'function' ? (value as (p: AppData[K]) => AppData[K])(prev[key]) : value
      if (next === prev[key]) return prev
      save(KEYS[key], next)
      return { ...prev, [key]: next }
    })
  }, [])

  const theme = useMemo(() => (data ? resolveTheme(data.themeId, data.customThemes) : null), [data?.themeId, data?.customThemes])

  if (!data || !theme) return null
  return <StoreContext.Provider value={{ data, theme, update }}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const s = useContext(StoreContext)
  if (!s) throw new Error('useStore fuera de StoreProvider')
  return s
}
