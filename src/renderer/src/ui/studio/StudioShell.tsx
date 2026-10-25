import { useEffect, useRef, useState } from 'react'
import { audioEngine } from '../../core/audio/AudioEngine'
import { mixerEngine } from '../../core/audio/MixerEngine'
import { AudioScreen } from '../screens/AudioScreen'
import { api } from '../storage'
import { useStore } from '../store'
import { CalibrationView } from './CalibrationView'
import { CompareView } from './CompareView'
import { DevicesView, useAutoProfile } from './DevicesView'
import { generator } from './generator'
import { AlarmBanner, HealthButton, HealthPanel, StageView, useHealth } from './health'
import { GeneratorView } from './GeneratorView'
import { LabView } from './LabView'
import { MixerView, useMixerState } from './MixerView'
import { MonitorView, useStudioPrefs } from './MonitorView'
import { setPlaybackDevice, stopPlayback } from './playback'
import { RecorderView } from './RecorderView'
import { SlmView } from './SlmView'
import type { StudioViewMode } from '../../core/studio/studio'
import './studio.css'

type Tab = 'monitor' | 'mixer' | 'slm' | 'calib' | 'recorder' | 'compare' | 'lab' | 'generator' | 'input' | 'devices'

const TABS: [Tab, string][] = [
  ['monitor', 'Monitor'],
  ['mixer', 'Mezclador'],
  ['slm', 'Sonómetro'],
  ['calib', 'Calibración'],
  ['recorder', 'Grabadora'],
  ['compare', 'Comparador'],
  ['lab', 'Laboratorio'],
  ['generator', 'Generador'],
  ['input', 'Entrada'],
  ['devices', 'Equipos']
]

/** Tabs kept in the measurement view (no mixing or recording) */
const MEASURE_TABS: Tab[] = ['monitor', 'slm', 'calib', 'compare', 'lab', 'generator', 'input', 'devices']

const VIEW_MODES: [StudioViewMode, string][] = [
  ['stage', 'Escenario'],
  ['studio', 'Estudio'],
  ['measure', 'Medición']
]

// Remembered while the app is open so leaving and re-entering the studio keeps the tab
let lastTab: Tab = 'monitor'

const SHORTCUTS: [string, string][] = [
  ['Ctrl+1 … Ctrl+9 · Ctrl+0', 'Cambiar de pestaña'],
  ['Alt+1 · Alt+2 · Alt+3', 'Vista Escenario · Estudio · Medición'],
  ['F11', 'Pantalla completa'],
  ['F · P', 'Monitor: fijar referencia · congelar analizador'],
  ['R · M', 'Grabadora: grabar/detener · marcador'],
  ['1 … 9 · Espacio', 'Comparador: escuchar toma (o cambiar en A/B) · detener'],
  ['?', 'Mostrar esta ayuda']
]

/** Hidden professional interface: metering, recording, mic comparison and test signals */
export function StudioShell({ standalone = false }: { standalone?: boolean }): JSX.Element {
  const { data, update } = useStore()
  const mixer = useMixerState()
  const [prefs, setPrefs] = useStudioPrefs()
  const [tab, setTabState] = useState<Tab>(lastTab)
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [help, setHelp] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)
  const health = useHealth()
  const profileNote = useAutoProfile()
  const main = useRef<HTMLElement>(null)
  const view = prefs.viewMode
  const tabs = view === 'measure' ? TABS.filter(([t]) => MEASURE_TABS.includes(t)) : TABS
  const shown: Tab = tabs.some(([t]) => t === tab) ? tab : tabs[0][0]
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const setPrefsRef = useRef(setPrefs)
  setPrefsRef.current = setPrefs
  const setTab = (t: Tab): void => {
    lastTab = t
    setTabState(t)
    // Each tab starts at the top (the scroll container is shared)
    if (main.current) main.current.scrollTop = 0
  }

  useEffect(() => {
    const previous = document.title
    document.title = 'Gritómetro Studio'
    // Monitoring never starts by itself: a stale "on" could feed back through speakers
    if (prefs.monitorDb !== null) setPrefs({ monitorDb: null })
    return () => {
      document.title = previous
      audioEngine.setMonitor(null)
      audioEngine.setSourceOverride(null)
      mixerEngine.stop()
      generator.stop()
      stopPlayback()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => audioEngine.setMonitor(prefs.monitorDb), [prefs.monitorDb])

  // Every mixer edit goes live (parameters instantly, structure by rebuilding)
  useEffect(() => mixerEngine.apply(data.mixer), [data.mixer])

  // Analyzers follow the chosen source; a mixer rebuild hands out a new bus stream
  const sourceBus = prefs.analysisSource !== 'input' && mixer.status === 'on' ? data.mixer.buses.find((b) => b.id === prefs.analysisSource) : undefined
  useEffect(() => {
    const stream = sourceBus ? mixerEngine.busStream(sourceBus.id) : null
    audioEngine.setSourceOverride(stream && sourceBus ? { stream, label: `Bus ${sourceBus.label} · ${sourceBus.name}` } : null)
  }, [sourceBus?.id, sourceBus?.label, sourceBus?.name, mixer.generation, mixer.status])

  // One output choice for monitoring, take playback and the generator
  useEffect(() => {
    audioEngine.setOutputDevice(prefs.outputDeviceId)
    generator.setOutput(prefs.outputDeviceId)
    setPlaybackDevice(prefs.outputDeviceId)
  }, [prefs.outputDeviceId])

  useEffect(() => {
    const load = (): void => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setOutputs(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'communications' && x.deviceId !== 'default')))
        .catch(() => setOutputs([]))
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      if (e.ctrlKey && !e.shiftKey && /^Digit[0-9]$/.test(e.code)) {
        e.preventDefault()
        // Ctrl+0 is the tenth tab, like a keyboard row
        const t = tabsRef.current[(Number(e.code.slice(5)) || 10) - 1]
        if (t) setTab(t[0])
      } else if (e.altKey && /^Digit[1-3]$/.test(e.code)) {
        e.preventDefault()
        setPrefsRef.current({
          viewMode: VIEW_MODES[Number(e.code.slice(5)) - 1][0]
        })
      } else if (!typing && e.key === '?') {
        setHelp((h) => !h)
      } else if (e.key === 'Escape') {
        setHelp(false)
        setHealthOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const exit = (): void => update('settings', (s) => ({ ...s, appMode: 'party' }))

  return (
    <div className="studio">
      <header className="st-topbar">
        <div className="st-brand">
          <span className="st-logo" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <b>Gritómetro</b> <span>Studio</span>
        </div>
        {view === 'stage' ? (
          <span className="st-stage-title">Vista de escenario</span>
        ) : (
          <nav className="st-tabs">
            {tabs.map(([id, label], i) => (
              <button key={id} className={shown === id ? 'on' : ''} onClick={() => setTab(id)} title={`Ctrl+${(i + 1) % 10}`}>
                {label}
              </button>
            ))}
          </nav>
        )}
        <div className="st-top-right">
          <select className="st-output st-view" value={view} onChange={(e) => setPrefs({ viewMode: e.target.value as StudioViewMode })} title="Vista (Alt+1/2/3)">
            {VIEW_MODES.map(([v, label]) => (
              <option key={v} value={v}>
                ▦ {label}
              </option>
            ))}
          </select>
          <select
            className="st-output"
            value={prefs.outputDeviceId ?? ''}
            onChange={(e) => setPrefs({ outputDeviceId: e.target.value || null })}
            title="Salida de audio para escucha, tomas y generador"
          >
            <option value="">🔊 Predeterminada</option>
            {outputs.map((o, i) => (
              <option key={o.deviceId} value={o.deviceId}>
                🔊 {o.label || `Salida ${i + 1}`}
              </option>
            ))}
          </select>
          {mixer.status === 'on' && (
            <select
              className="st-output"
              value={sourceBus ? sourceBus.id : 'input'}
              onChange={(e) => setPrefs({ analysisSource: e.target.value })}
              title="Qué analizan el Monitor, el Sonómetro, la Grabadora y el Comparador"
            >
              <option value="input">🔍 Entrada del perfil</option>
              {data.mixer.buses.map((b) => (
                <option key={b.id} value={b.id}>
                  🔍 Bus {b.label} · {b.name}
                </option>
              ))}
            </select>
          )}
          {mixer.status === 'on' && (
            <button className="st-btn on st-mixer-on" onClick={() => setTab('mixer')} title="El mezclador está encendido">
              MIX
            </button>
          )}
          {prefs.monitorDb !== null && (
            <button className="st-btn on" onClick={() => setPrefs({ monitorDb: null })} title="Escucha de entrada activa: clic para cortar">
              🎧 {prefs.monitorDb} dB
            </button>
          )}
          <HealthButton items={health} open={healthOpen} onClick={() => setHealthOpen((o) => !o)} />
          <button className="st-btn ghost" onClick={() => setHelp((h) => !h)} title="Atajos de teclado (?)">
            ?
          </button>
          <button className="st-btn ghost" onClick={() => api()?.window.toggleFullscreen()} title="Pantalla completa (F11)">
            ⛶
          </button>
          {!standalone && (
            <button className="st-btn" onClick={exit} title="Ctrl+Shift+S">
              Salir del modo estudio
            </button>
          )}
        </div>
      </header>
      <AlarmBanner items={health} />
      {profileNote && <div className="st-toast">{profileNote}</div>}
      <main className="st-main" ref={main}>
        {view === 'stage' && <StageView items={health} />}
        {view !== 'stage' && (
          <>
            {shown === 'monitor' && <MonitorView />}
            {shown === 'mixer' && <MixerView />}
            {shown === 'slm' && <SlmView />}
            {shown === 'calib' && <CalibrationView />}
            {shown === 'recorder' && <RecorderView />}
            {shown === 'compare' && <CompareView />}
            {shown === 'lab' && <LabView />}
            {shown === 'generator' && <GeneratorView />}
            {shown === 'input' && (
              <div className="st-embedded">
                <AudioScreen navigate={() => setTab('monitor')} studio />
              </div>
            )}
            {shown === 'devices' && <DevicesView />}
          </>
        )}
      </main>
      {healthOpen && <HealthPanel items={health} onClose={() => setHealthOpen(false)} />}
      {help && (
        <div className="st-help" onClick={() => setHelp(false)}>
          <div className="st-panel" onClick={(e) => e.stopPropagation()}>
            <header className="st-panel-head">
              <h2>Atajos de teclado</h2>
              <button className="st-btn ghost" onClick={() => setHelp(false)}>
                ✕
              </button>
            </header>
            <table className="st-table">
              <tbody>
                {(standalone ? SHORTCUTS : [SHORTCUTS[0], ['Ctrl+Shift+S', 'Entrar / salir del modo estudio'] as [string, string], ...SHORTCUTS.slice(1)]).map(([k, d]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
