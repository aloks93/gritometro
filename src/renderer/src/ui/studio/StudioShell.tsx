import { useEffect, useState } from 'react'
import { audioEngine } from '../../core/audio/AudioEngine'
import { useEngineState } from '../hooks'
import { AudioScreen } from '../screens/AudioScreen'
import { api } from '../storage'
import { useStore } from '../store'
import { CompareView } from './CompareView'
import { generator } from './generator'
import { GeneratorView } from './GeneratorView'
import { MonitorView, useStudioPrefs } from './MonitorView'
import { setPlaybackDevice, stopPlayback } from './playback'
import { RecorderView } from './RecorderView'
import { SlmView } from './SlmView'
import './studio.css'

type Tab = 'monitor' | 'slm' | 'recorder' | 'compare' | 'generator' | 'input'

const TABS: [Tab, string][] = [
  ['monitor', 'Monitor'],
  ['slm', 'Sonómetro'],
  ['recorder', 'Grabadora'],
  ['compare', 'Comparador'],
  ['generator', 'Generador'],
  ['input', 'Entrada']
]

// Remembered while the app is open so leaving and re-entering the studio keeps the tab
let lastTab: Tab = 'monitor'

const SHORTCUTS: [string, string][] = [
  ['Ctrl+1 … Ctrl+6', 'Cambiar de pestaña'],
  ['F11', 'Pantalla completa'],
  ['F · P', 'Monitor: fijar referencia · congelar analizador'],
  ['R · M', 'Grabadora: grabar/detener · marcador'],
  ['1 … 9 · Espacio', 'Comparador: escuchar toma (o cambiar en A/B) · detener'],
  ['?', 'Mostrar esta ayuda']
]

/** Hidden professional interface: metering, recording, mic comparison and test signals */
export function StudioShell({ standalone = false }: { standalone?: boolean }): JSX.Element {
  const { update } = useStore()
  const engine = useEngineState()
  const [prefs, setPrefs] = useStudioPrefs()
  const [tab, setTabState] = useState<Tab>(lastTab)
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [help, setHelp] = useState(false)
  const setTab = (t: Tab): void => {
    lastTab = t
    setTabState(t)
  }

  useEffect(() => {
    const previous = document.title
    document.title = 'Gritómetro Studio'
    // Monitoring never starts by itself: a stale "on" could feed back through speakers
    if (prefs.monitorDb !== null) setPrefs({ monitorDb: null })
    return () => {
      document.title = previous
      audioEngine.setMonitor(null)
      generator.stop()
      stopPlayback()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => audioEngine.setMonitor(prefs.monitorDb), [prefs.monitorDb])

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
      if (e.ctrlKey && !e.shiftKey && /^Digit[1-6]$/.test(e.code)) {
        e.preventDefault()
        setTab(TABS[Number(e.code.slice(5)) - 1][0])
      } else if (!typing && e.key === '?') {
        setHelp((h) => !h)
      } else if (e.key === 'Escape') {
        setHelp(false)
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
        <nav className="st-tabs">
          {TABS.map(([id, label], i) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} title={`Ctrl+${i + 1}`}>
              {label}
            </button>
          ))}
        </nav>
        <div className="st-top-right">
          <select
            className="st-output"
            value={prefs.outputDeviceId ?? ''}
            onChange={(e) => setPrefs({ outputDeviceId: e.target.value || null })}
            title="Salida de audio para escucha, tomas y generador"
          >
            <option value="">🔊 Salida predeterminada</option>
            {outputs.map((o, i) => (
              <option key={o.deviceId} value={o.deviceId}>
                🔊 {o.label || `Salida ${i + 1}`}
              </option>
            ))}
          </select>
          {prefs.monitorDb !== null && (
            <button className="st-btn on" onClick={() => setPrefs({ monitorDb: null })} title="Escucha de entrada activa: clic para cortar">
              🎧 {prefs.monitorDb} dB
            </button>
          )}
          <span className={`st-status ${engine.status}`}>
            <i /> {engine.status === 'running' ? `${engine.sampleRate ? engine.sampleRate / 1000 : '?'} kHz` : engine.status === 'starting' ? '…' : 'Sin señal'}
          </span>
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
      <main className="st-main">
        {tab === 'monitor' && <MonitorView />}
        {tab === 'slm' && <SlmView />}
        {tab === 'recorder' && <RecorderView />}
        {tab === 'compare' && <CompareView />}
        {tab === 'generator' && <GeneratorView />}
        {tab === 'input' && (
          <div className="st-embedded">
            <AudioScreen navigate={() => setTab('monitor')} studio />
          </div>
        )}
      </main>
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
