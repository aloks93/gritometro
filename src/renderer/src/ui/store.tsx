import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { defaultAudioSettings, type AudioSettings } from '../core/audio/AudioConfig'
import { screamTitle } from '../core/game/leaderboard'
import { newId, type Player } from '../core/players/players'
import { normalizeCode } from '../core/players/roster'
import { defaultGameSettings, type GameSettings } from '../core/settings/settings'
import { mergeMixer, type MixerConfig } from '../core/mixer/mixer'
import { mergeProcessor, type ProcessorConfig } from '../core/processor/processor'
import { mergeStudio, type StudioData } from '../core/studio/studio'
import type { CustomTheme, Theme } from '../themes/Theme'
import { DEFAULT_THEME_ID, resolveTheme } from '../themes/registry'
import { load, saveDebounced } from './storage'

export interface RecordEntry {
  id: string
  playerId: string
  playerName: string
  score: number
  modeId: string
  date: string
  /** Approximate dB SPL of the sustained peak */
  db?: number
  /** Badge code at the time, so the ranking survives re-importing the guest list */
  playerCode?: string
  /** Funny title earned (screamTitle label) */
  title?: string
}

/** History entry for one scored scream (title and badge code included) */
export function screamRecord(player: Player, score: number, modeId: string, db?: number): RecordEntry {
  return {
    id: newId('r'),
    playerId: player.id,
    playerName: player.name,
    playerCode: player.code,
    score,
    modeId,
    date: new Date().toISOString(),
    db,
    title: screamTitle(score).label
  }
}

/** Personal best of a player (by id, or by badge code across re-imports) */
export function personalBest(records: RecordEntry[], player: Player): number | undefined {
  const code = normalizeCode(player.code)
  const mine = records.filter((r) => r.modeId !== 'target' && (r.playerId === player.id || (code && normalizeCode(r.playerCode) === code)))
  return mine.length ? Math.max(...mine.map((r) => r.score)) : undefined
}

export interface AppData {
  settings: GameSettings
  audio: AudioSettings
  players: Player[]
  records: RecordEntry[]
  customThemes: CustomTheme[]
  themeId: string
  studio: StudioData
  mixer: MixerConfig
  processor: ProcessorConfig
}

const KEYS: Record<keyof AppData, string> = {
  settings: 'settings',
  audio: 'audio',
  players: 'players',
  records: 'records',
  customThemes: 'custom-themes',
  themeId: 'theme',
  studio: 'studio',
  mixer: 'mixer',
  processor: 'processor'
}

type Updater<T> = T | ((prev: T) => T)

interface Store {
  data: AppData
  theme: Theme
  update: <K extends keyof AppData>(key: K, value: Updater<AppData[K]>) => void
}

const StoreContext = createContext<Store | null>(null)

async function loadAll(): Promise<AppData> {
  const [settings, audio, players, records, customThemes, themeId, studio, mixer, processor] = await Promise.all([
    load<Partial<GameSettings>>(KEYS.settings, {}),
    load<AudioSettings | null>(KEYS.audio, null),
    load<Player[]>(KEYS.players, []),
    load<RecordEntry[]>(KEYS.records, []),
    load<CustomTheme[]>(KEYS.customThemes, []),
    load<string>(KEYS.themeId, DEFAULT_THEME_ID),
    load<Partial<StudioData>>(KEYS.studio, {}),
    load<Partial<MixerConfig> | null>(KEYS.mixer, null),
    load<Partial<ProcessorConfig> | null>(KEYS.processor, null)
  ])
  // Merge with defaults so settings added in newer versions get sane values
  const audioSettings = audio && audio.profiles?.length ? { ...defaultAudioSettings(), ...audio } : defaultAudioSettings()
  return {
    settings: { ...defaultGameSettings(), ...settings },
    audio: audioSettings,
    players,
    records,
    customThemes,
    themeId,
    studio: mergeStudio(studio),
    mixer: mergeMixer(mixer),
    processor: mergeProcessor(processor)
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
      saveDebounced(KEYS[key], next)
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
