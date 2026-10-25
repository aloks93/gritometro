import { useEffect, useRef, useState } from 'react'
import { multiProcessor } from '../../core/audio/MultiProcessor'
import { processorEngine } from '../../core/audio/ProcessorEngine'
import { mainConfig } from '../../core/processor/channels'
import { api } from '../storage'
import { useStore } from '../store'
import { Icon } from './controls'
import { resolveLang, useStudioTranslation, type StudioLangPref } from './i18n'
import { InterfacesView } from './InterfacesView'
import { useStudioPrefs } from './MonitorView'
import { ProcessorView } from './ProcessorView'
import { Segmented } from './widgets'
import './studio.css'

// Standalone "Gritómetro Procesador" edition: only the mic processor (and its channel view for
// multichannel interfaces), with its own window chrome.

type Page = 'processor' | 'channels'
let lastPage: Page = 'processor'

export function ProcessorShell(): JSX.Element {
  const { data } = useStore()
  const [prefs] = useStudioPrefs()
  const lang = resolveLang(prefs.language)

  // Out here, so a language change (which remounts the body) doesn't stop the audio
  useEffect(() => {
    document.title = 'Gritómetro Procesador'
    return () => {
      processorEngine.stop()
      multiProcessor.stopAll()
    }
  }, [])

  // Every edit goes live (parameters instantly, structure by rebuilding), parallel channels too
  useEffect(() => {
    processorEngine.apply(mainConfig(data.processor))
    multiProcessor.apply(data.processor)
  }, [data.processor])

  // Remounting on a language change lets every view render its Spanish source text again
  return <ProcessorBody key={lang} english={lang === 'en'} />
}

function ProcessorBody({ english }: { english: boolean }): JSX.Element {
  const [prefs, setPrefs] = useStudioPrefs()
  const [help, setHelp] = useState(false)
  const [page, setPageState] = useState<Page>(lastPage)
  const main = useRef<HTMLElement>(null)
  const setPage = (p: Page): void => {
    lastPage = p
    setPageState(p)
    if (main.current) main.current.scrollTop = 0
  }
  const setPageRef = useRef(setPage)
  setPageRef.current = setPage
  const root = useRef<HTMLDivElement>(null)
  useStudioTranslation(english, root)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F11') {
        e.preventDefault()
        api()?.window.toggleFullscreen()
      } else if (e.key === 'Escape') setHelp(false)
      else if (e.key === '?' && !(e.target instanceof HTMLInputElement)) setHelp((h) => !h)
      else if (e.altKey && e.key === '1') setPageRef.current('processor')
      else if (e.altKey && e.key === '2') setPageRef.current('channels')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="studio vp-app" ref={root}>
      <header className="st-topbar vp-topbar">
        <div className="vp-brand">
          <ProcessorMark />
          <div>
            <b>Gritómetro</b>
            <span>Procesador vocal</span>
          </div>
        </div>
        <Segmented<Page>
          value={page}
          onChange={setPage}
          options={[
            ['processor', 'Procesador'],
            ['channels', 'Canales']
          ]}
        />
        <span className="vp-grow" />
        <select className="st-output st-lang" value={prefs.language} onChange={(e) => setPrefs({ language: e.target.value as StudioLangPref })} title="Idioma">
          <option value="auto">Auto</option>
          <option value="es">ES</option>
          <option value="en">EN</option>
        </select>
        <button className="st-btn ghost" onClick={() => setHelp((h) => !h)} title="Atajos de teclado (?)">
          <Icon name="help" size={16} />
        </button>
        <button className="st-btn ghost" onClick={() => api()?.window.toggleFullscreen()} title="Pantalla completa (F11)">
          <Icon name="fullscreen" size={16} />
        </button>
      </header>
      <main className="st-main" ref={main}>
        {page === 'processor' ? <ProcessorView onOpenChannels={() => setPage('channels')} /> : <InterfacesView onOpenProcessor={() => setPage('processor')} />}
      </main>
      {help && (
        <div className="st-help" onClick={() => setHelp(false)}>
          <div className="st-panel" onClick={(e) => e.stopPropagation()}>
            <header className="st-panel-head">
              <h2>Atajos de teclado</h2>
              <button className="st-btn ghost" onClick={() => setHelp(false)} title="Cerrar">
                <Icon name="close" size={14} />
              </button>
            </header>
            <table className="st-table">
              <tbody>
                {(
                  [
                    ['B', 'Bypass A/B (micrófono sin procesar)'],
                    ['Alt+1 / Alt+2', 'Procesador / Canales'],
                    ['F11', 'Pantalla completa'],
                    ['?', 'Mostrar esta ayuda'],
                    ['Arrastrar perilla', 'Subir/bajar · Shift = ajuste fino · doble clic = valor por defecto'],
                    ['Rueda del ratón', 'Perilla: ajustar · gráfico EQ: ancho (Q) de la banda']
                  ] as [string, string][]
                ).map(([k, d]) => (
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

/** Brand mark: same artwork as the app icon (build/processor/icon.svg), simplified */
export function ProcessorMark({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="vp-mark-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e252e" />
          <stop offset="1" stopColor="#0b0e12" />
        </linearGradient>
        <linearGradient id="vp-mark-wave" x1="0" x2="1">
          <stop offset="0" stopColor="#3fb6ff" />
          <stop offset="1" stopColor="#4dd6c9" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#vp-mark-bg)" stroke="#2e3640" />
      <path d="M8 32h6l3-12 4 24 4-30 4 34 3-20 3 8h3l2-4 2 4 2-2 2 2h4" fill="none" stroke="url(#vp-mark-wave)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 46c10 0 12-8 24-8s14 8 24 8" fill="none" stroke="#ffb020" strokeWidth="2.4" strokeLinecap="round" opacity="0.9" />
    </svg>
  )
}
