import { useEffect, useState } from 'react'
import { useEngineState } from '../hooks'
import { AudioScreen } from '../screens/AudioScreen'
import { api } from '../storage'
import { useStore } from '../store'
import { CompareView } from './CompareView'
import { MonitorView } from './MonitorView'
import './studio.css'

type Tab = 'monitor' | 'compare' | 'input'

/** Hidden professional interface: live metering + microphone comparator */
export function StudioShell(): JSX.Element {
  const { update } = useStore()
  const engine = useEngineState()
  const [tab, setTab] = useState<Tab>('monitor')

  useEffect(() => {
    const previous = document.title
    document.title = 'Gritómetro Studio'
    return () => {
      document.title = previous
    }
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
          {(
            [
              ['monitor', 'Monitor'],
              ['compare', 'Comparador de micrófonos'],
              ['input', 'Entrada y perfiles']
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="st-top-right">
          <span className={`st-status ${engine.status}`}>
            <i /> {engine.status === 'running' ? `${engine.sampleRate ? engine.sampleRate / 1000 : '?'} kHz` : engine.status === 'starting' ? '…' : 'Sin señal'}
          </span>
          <button className="st-btn ghost" onClick={() => api()?.window.toggleFullscreen()} title="Pantalla completa (F11)">
            ⛶
          </button>
          <button className="st-btn" onClick={exit} title="Ctrl+Shift+S">
            Salir del modo estudio
          </button>
        </div>
      </header>
      <main className="st-main">
        {tab === 'monitor' && <MonitorView />}
        {tab === 'compare' && <CompareView />}
        {tab === 'input' && (
          <div className="st-embedded">
            <AudioScreen navigate={() => setTab('monitor')} />
          </div>
        )}
      </main>
    </div>
  )
}
