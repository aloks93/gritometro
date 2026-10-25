import { useEffect, useState } from 'react'
import { effectiveProfile, type AudioSettings } from './core/audio/AudioConfig'
import { audioEngine } from './core/audio/AudioEngine'
import type { Theme } from './themes/Theme'
import { AppBackground } from './ui/components/Meter'
import type { Route } from './ui/nav'
import { api } from './ui/storage'
import { StoreProvider, useStore } from './ui/store'
import { AudioScreen } from './ui/screens/AudioScreen'
import { CustomizeScreen } from './ui/screens/CustomizeScreen'
import { GameScreen } from './ui/screens/GameScreen'
import { HomeScreen } from './ui/screens/HomeScreen'
import { ModesScreen } from './ui/screens/ModesScreen'
import { PlayersScreen } from './ui/screens/PlayersScreen'
import { RecordsScreen } from './ui/screens/RecordsScreen'
import { SettingsScreen } from './ui/screens/SettingsScreen'

/** Publishes theme tokens as CSS variables: --c-<token>, --font-display, --font-body, --radius */
function useThemeVars(theme: Theme): void {
  useEffect(() => {
    const root = document.documentElement.style
    const { fontDisplay, fontBody, radius, ...colors } = theme.tokens
    Object.entries(colors).forEach(([k, v]) => root.setProperty(`--c-${k}`, v))
    root.setProperty('--font-display', fontDisplay)
    root.setProperty('--font-body', fontBody)
    root.setProperty('--radius', radius)
  }, [theme.tokens])
}

/** Keeps the microphone open with the active profile; restarts when relevant settings change */
function useAudioBoot(audio: AudioSettings): void {
  const { noiseFloorDb: _floor, name: _name, ...relevant } = effectiveProfile(audio)
  const key = JSON.stringify(relevant)

  useEffect(() => {
    // Debounced so dragging a gain slider doesn't reopen the device 60 times
    const t = setTimeout(() => audioEngine.start(effectiveProfile(audio)), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    const onChange = (): void => {
      const s = audioEngine.state.status
      if (s === 'disconnected' || s === 'error') setTimeout(() => audioEngine.restart(), 600)
    }
    navigator.mediaDevices?.addEventListener('devicechange', onChange)
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', onChange)
    }
  }, [])

  useEffect(() => () => audioEngine.stop(), [])
}

function Shell(): JSX.Element {
  const { data, theme } = useStore()
  const [route, setRoute] = useState<Route>({ name: 'home' })
  useThemeVars(theme)
  useAudioBoot(data.audio)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F11') {
        e.preventDefault()
        api()?.window.toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.title = theme.texts.appTitle
  }, [theme.texts.appTitle])

  const navigate = setRoute
  let screen: JSX.Element
  switch (route.name) {
    case 'players':
      screen = <PlayersScreen navigate={navigate} />
      break
    case 'modes':
      screen = <ModesScreen navigate={navigate} />
      break
    case 'game':
      screen = <GameScreen key={JSON.stringify(route.session.config) + route.session.modeId} session={route.session} navigate={navigate} />
      break
    case 'records':
      screen = <RecordsScreen navigate={navigate} />
      break
    case 'customize':
      screen = <CustomizeScreen navigate={navigate} />
      break
    case 'audio':
      screen = <AudioScreen navigate={navigate} />
      break
    case 'settings':
      screen = <SettingsScreen navigate={navigate} />
      break
    default:
      screen = <HomeScreen navigate={navigate} />
  }

  return (
    <div className={`app ${data.settings.projectorMode ? 'projector' : ''}`} data-theme={theme.id}>
      <AppBackground />
      <div className="app-content">{screen}</div>
    </div>
  )
}

export function App(): JSX.Element {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
