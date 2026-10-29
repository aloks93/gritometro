import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { audioEngine } from '../../core/audio/AudioEngine'
import { effectiveProfile } from '../../core/audio/AudioConfig'
import { scoreScream, type ScoreResult } from '../../core/audio/ScoreEngine'
import { handicapFor, type Player } from '../../core/players/players'
import { findByCode } from '../../core/players/roster'
import { Meter, Reveal } from '../components/Meter'
import { EmployeeBadge, Keypad, Leaderboard, ScreamTitleBadge } from '../components/Factory'
import { useEngineState, useKey, useLevel } from '../hooks'
import type { Navigate } from '../nav'
import { useSounds } from '../sound'
import { personalBest, screamRecord, useStore } from '../store'

type Phase = 'login' | 'ready' | 'countdown' | 'active' | 'result'

interface BadgeResult {
  score: ScoreResult
  isRecord: boolean
  /** Beat their own best (and had one before) */
  personalBest: boolean
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Free play by badge: each guest types their employee code, screams, and lands in the TOP 10 */
export function BadgeScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, theme, update } = useStore()
  const sounds = useSounds()
  const engine = useEngineState()
  const { level, reading } = useLevel()
  const settings = data.settings
  const profile = effectiveProfile(data.audio)

  const [phase, setPhase] = useState<Phase>('login')
  const [code, setCode] = useState('')
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [held, setHeld] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<BadgeResult | null>(null)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  // Live player so photo/name edits show up, but the turn keeps going if they're removed mid-scream
  const lastPlayer = useRef<Player | null>(null)
  const player = data.players.find((p) => p.id === playerId) ?? (playerId ? lastPlayer.current : null)
  if (player) lastPlayer.current = player
  const multiplier = handicapFor(player?.age, settings.handicapRules, settings.handicapEnabled)
  const best = player ? personalBest(data.records, player) : undefined
  const bestRecord = useMemo(() => Math.max(0, ...data.records.filter((r) => r.modeId !== 'target').map((r) => r.score)), [data.records])
  const confettiColors = useMemo(() => [theme.tokens.primary, theme.tokens.accent, theme.tokens.success], [theme])
  const withCode = data.players.filter((p) => p.code).length

  useEffect(() => {
    if (phase === 'active' && level > held) setHeld(level)
    // Idle meter: slowly decaying marker so guests can warm up while others type
    if (phase === 'login' || phase === 'ready') setHeld((h) => Math.max(level, h - 0.004))
  }, [phase, level, held])

  const login = (): void => {
    const p = findByCode(data.players, code)
    if (!p) {
      setError(`No hay ningún empleado con el carnet ${code}`)
      sounds.tick()
      return
    }
    setError('')
    setCode('')
    setPlayerId(p.id)
    setPhase('ready')
    sounds.go()
  }

  const logout = useCallback(() => {
    setPlayerId(null)
    setResult(null)
    setError('')
    setHeld(0)
    setPhase('login')
  }, [])

  const start = useCallback(async () => {
    if (!player || phase !== 'ready') return
    if (engine.status !== 'running') {
      setError('El micrófono no está listo. Ve a Audio para elegirlo.')
      return
    }
    setError('')
    setHeld(0)
    setElapsed(0)
    setPhase('countdown')
    for (let i = settings.countdownSeconds; i > 0; i--) {
      setCount(i)
      sounds.tick()
      await wait(1000)
      if (!alive.current) return
    }
    sounds.go()
    setCount(0)
    // Let the "go" beep die out so it isn't measured
    await wait(220)
    if (!alive.current) return
    setPhase('active')
    const t0 = performance.now()
    const timer = setInterval(() => setElapsed((performance.now() - t0) / 1000), 100)
    const frames = await audioEngine.record(settings.screamSeconds * 1000)
    clearInterval(timer)
    if (!alive.current) return
    if (audioEngine.state.status !== 'running') {
      setError('Se perdió el micrófono durante el grito. Revisa la conexión y repite.')
      setPhase('ready')
      return
    }
    const score = scoreScream(frames, {
      noiseFloorDb: profile.noiseFloorDb,
      rangeDb: settings.rangeDb,
      minBurstMs: settings.minBurstMs,
      multiplier
    })
    const isRecord = data.records.length > 0 && score.score > bestRecord
    update('records', (rs) => [...rs, screamRecord(player, score.score, 'badge', Math.round(score.sustainedPeakDb + profile.splOffset))])
    setResult({ score, isRecord, personalBest: best !== undefined && score.score > best })
    setPhase('result')
    if (isRecord) sounds.record()
    else sounds.result()
  }, [player, phase, engine.status, settings, sounds, profile, multiplier, data.records.length, bestRecord, best, update])

  useKey('Space', phase === 'ready' ? start : logout, phase === 'ready' || phase === 'result')
  useKey('Escape', logout, phase === 'ready' || phase === 'result')

  const meterLevel = phase === 'result' && result ? Math.min(1, result.score.score / 100) : level
  const liveSpl = reading ? Math.round(reading.smoothedDb + profile.splOffset) : null

  return (
    <div className={`screen game-screen badge-screen phase-${phase}`}>
      <header className="screen-header">
        <button className="btn ghost" onClick={() => navigate({ name: 'home' })}>
          ← Salir
        </button>
        <h1 className="screen-title">🪪 Turno con carnet</h1>
        <div className="screen-actions">
          <span className="chip">{withCode} empleados con carnet</span>
        </div>
      </header>

      <div className="game-layout with-top">
        <aside className="game-side badge-side">
          {phase === 'login' || !player ? (
            <>
              <h3>Pasa tu carnet</h3>
              <Keypad
                value={code}
                onChange={(v) => {
                  setCode(v)
                  setError('')
                }}
                onSubmit={login}
                error={error}
                enabled={phase === 'login'}
              />
              {withCode === 0 && (
                <p className="muted">
                  Ningún jugador tiene número de carnet. Cárgalos en{' '}
                  <button className="btn small" onClick={() => navigate({ name: 'players' })}>
                    Jugadores
                  </button>
                </p>
              )}
            </>
          ) : (
            <>
              <EmployeeBadge player={player} factory={theme.texts.appTitle} best={best} compact={phase !== 'ready'} />
              {multiplier !== 1 && <span className="chip">Bonus x{multiplier} por edad</span>}
              {(phase === 'ready' || phase === 'result') && (
                <button className="btn ghost small" onClick={logout}>
                  Cambiar de empleado (Esc)
                </button>
              )}
            </>
          )}
        </aside>

        <main className="game-stage">
          <div className="stage-center">
            <div className="stage-meter">
              <Meter
                level={meterLevel}
                held={phase === 'countdown' ? 0 : held}
                active={phase === 'active'}
                score={phase === 'result' ? result?.score.score : null}
                clipped={reading?.clipped}
              />
            </div>

            <div className="stage-message">
              {phase === 'login' && (
                <>
                  <p className="big-text">¿Quién se anima?</p>
                  <p className="muted">Escribe tu número de carnet y pulsa OK</p>
                </>
              )}
              {phase === 'ready' && player && (
                <>
                  <p className="big-text">¡Hola, {player.name.split(' ')[0]}!</p>
                  <button className="btn primary huge" onClick={start}>
                    🎤 {theme.texts.screamCta}
                  </button>
                  <p className="muted">o pulsa ESPACIO</p>
                </>
              )}
              {phase === 'countdown' && (
                <div className="countdown" key={count}>
                  {count || '¡YA!'}
                </div>
              )}
              {phase === 'active' && (
                <>
                  <p className="cta-text">{theme.texts.screamCta}</p>
                  <div className="progress">
                    <div style={{ width: `${Math.min(100, (elapsed / settings.screamSeconds) * 100)}%` }} />
                  </div>
                  {settings.showDb && liveSpl !== null && <p className="db-live">≈ {liveSpl} dB</p>}
                </>
              )}
              {phase === 'result' && result && player && (
                <Reveal key={result.score.score + player.id}>
                  <div className="result-card">
                    {result.isRecord && <div className="record-banner">{theme.texts.newRecord}</div>}
                    {!result.isRecord && result.personalBest && <div className="chip">⭐ ¡Superaste tu mejor grito!</div>}
                    <p className="result-name">{player.name}</p>
                    <p className="result-score">{result.score.score.toFixed(1)}</p>
                    <ScreamTitleBadge score={result.score.score} />
                    {settings.showDb && (
                      <p className="muted">
                        ≈ {Math.round(result.score.sustainedPeakDb + profile.splOffset)} dB
                        {result.score.clipped && ' · ⚠️ saturó'}
                      </p>
                    )}
                    <button className="btn primary huge" onClick={logout}>
                      Siguiente empleado ➜
                    </button>
                  </div>
                </Reveal>
              )}
              {error && phase !== 'login' && <p className="error">{error}</p>}
              {engine.status !== 'running' && (phase === 'login' || phase === 'ready') && (
                <button className="btn" onClick={() => navigate({ name: 'audio' })}>
                  Configurar micrófono
                </button>
              )}
            </div>
          </div>
        </main>

        <aside className="game-side game-top">
          <Leaderboard records={data.records} players={data.players} highlight={playerId ?? undefined} colors={confettiColors} />
        </aside>
      </div>
    </div>
  )
}
