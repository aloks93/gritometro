import { useEffect, useState } from 'react'
import { Meter } from '../components/Meter'
import { useEngineState, useLevel } from '../hooks'
import type { Navigate } from '../nav'
import { api } from '../storage'
import { useStore } from '../store'

export function HomeScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, theme } = useStore()
  const engine = useEngineState()
  const { level } = useLevel()
  const [held, setHeld] = useState(0)

  // Slowly decaying "best" marker so kids can test the meter on the home screen
  useEffect(() => {
    setHeld((h) => Math.max(level, h - 0.004))
  }, [level])

  const best = data.records.reduce((m, r) => (r.score > m.score ? r : m), { score: 0, playerName: '' })

  return (
    <div className="screen home-screen">
      <div className="home-hero">
        {theme.images.logo && <img className="home-logo" src={theme.images.logo} alt="" />}
        <h1 className="home-title">{theme.texts.appTitle}</h1>
        <p className="home-subtitle">{theme.texts.subtitle}</p>
        <div className="row center">
          <button className="btn primary huge" onClick={() => navigate({ name: data.players.length ? 'modes' : 'players' })}>
            🎮 ¡Jugar!
          </button>
        </div>
        <div className="home-grid">
          <button className="btn tile" onClick={() => navigate({ name: 'players' })}>
            👾 Jugadores <small>{data.players.length}</small>
          </button>
          <button className="btn tile" onClick={() => navigate({ name: 'records' })}>
            🏆 Récords
          </button>
          <button className="btn tile" onClick={() => navigate({ name: 'customize' })}>
            🎨 Personalizar
          </button>
          <button className="btn tile" onClick={() => navigate({ name: 'audio' })}>
            🎤 Audio
          </button>
          <button className="btn tile" onClick={() => navigate({ name: 'settings' })}>
            ⚙️ Ajustes
          </button>
          <button className="btn tile" onClick={() => api()?.window.toggleFullscreen()}>
            ⛶ Pantalla completa
          </button>
        </div>
        {best.score > 0 && (
          <p className="home-record">
            Récord de la fiesta: <strong>{best.playerName}</strong> con {best.score.toFixed(1)} pts
          </p>
        )}
      </div>
      <div className="home-meter">
        <Meter level={level} held={held} active={level > 0.05} />
        <span className={`chip status-${engine.status}`}>
          {engine.status === 'running' ? `🎤 ${engine.label || 'Micrófono listo'}` : engine.error || 'Micrófono apagado'}
        </span>
        <small className="muted">¡Prueba a gritar aquí!</small>
      </div>
    </div>
  )
}
