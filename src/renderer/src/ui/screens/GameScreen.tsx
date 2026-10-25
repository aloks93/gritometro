import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import confetti from 'canvas-confetti'
import { audioEngine } from '../../core/audio/AudioEngine'
import { effectiveProfile } from '../../core/audio/AudioConfig'
import { scoreScream, SilenceWatcher, SustainWatcher, type ScoreResult } from '../../core/audio/ScoreEngine'
import { normalizeLevel } from '../../core/audio/LevelAnalyzer'
import { getMode } from '../../core/game/registry'
import type { Standing, Turn, TurnKind } from '../../core/game/GameMode'
import { handicapFor, isBirthdayPlayer, newId, type Player } from '../../core/players/players'
import { levelLabel } from '../../themes/Theme'
import { Meter, Reveal } from '../components/Meter'
import { MonsterAvatar } from '../components/MonsterAvatar'
import { ModeViewPanel, StandingsList } from '../components/ModeViews'
import { Certificate } from '../components/Certificate'
import { WinnerPhoto } from '../components/WinnerPhoto'
import { useEngineState, useKey, useLevel } from '../hooks'
import type { GameSession, Navigate } from '../nav'
import { useSounds } from '../sound'
import { useStore } from '../store'

type Phase = 'ready' | 'countdown' | 'active' | 'result' | 'done'

interface LastResult {
  turn: Turn
  value: number
  score?: ScoreResult
  isRecord: boolean
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function GameScreen({ session, navigate }: { session: GameSession; navigate: Navigate }): JSX.Element {
  const { data, theme, update } = useStore()
  const sounds = useSounds()
  const engine = useEngineState()
  const { level, reading } = useLevel()
  const mode = getMode(session.modeId)!
  const { ctx } = session
  const settings = data.settings
  const profile = effectiveProfile(data.audio)

  const [state, setState] = useState(() => mode.init(ctx, session.config))
  const [phase, setPhase] = useState<Phase>('ready')
  const [count, setCount] = useState(0)
  const [held, setHeld] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [last, setLast] = useState<LastResult | null>(null)
  const [error, setError] = useState('')
  const [overlay, setOverlay] = useState<'certificate' | 'photo' | null>(null)
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const turn = useMemo(() => mode.nextTurn(state), [mode, state])
  const standings = useMemo(() => mode.standings(state, ctx), [mode, state, ctx])
  const view = mode.view?.(state, ctx)
  const player = turn ? ctx.players.find((p) => p.id === turn.playerId) : undefined
  const team = turn?.teamId ? ctx.teams.find((t) => t.id === turn.teamId) : undefined
  const multiplier = handicapFor(player?.age, settings.handicapRules, settings.handicapEnabled)
  const bestRecord = useMemo(() => Math.max(0, ...data.records.map((r) => r.score)), [data.records])

  // Track the best level reached during the active window
  useEffect(() => {
    if (phase === 'active' && level > held) setHeld(level)
  }, [phase, level, held])

  const runScream = async (t: Turn, p: Player): Promise<void> => {
    const start = performance.now()
    const timer = setInterval(() => setElapsed((performance.now() - start) / 1000), 100)
    const frames = await audioEngine.record(settings.screamSeconds * 1000)
    clearInterval(timer)
    if (!alive.current) return
    if (audioEngine.state.status !== 'running') {
      setError('Se perdió el micrófono durante el grito. Revisa la conexión y repite el turno.')
      setPhase('ready')
      return
    }
    const score = scoreScream(frames, {
      noiseFloorDb: profile.noiseFloorDb,
      rangeDb: settings.rangeDb,
      minBurstMs: settings.minBurstMs,
      multiplier
    })
    // The very first scream of the party isn't a "record" yet
    const isRecord = data.records.length > 0 && score.score > bestRecord
    update('records', (rs) => [
      ...rs,
      {
        id: newId('r'),
        playerId: p.id,
        playerName: p.name,
        score: score.score,
        modeId: mode.id,
        date: new Date().toISOString(),
        db: Math.round(score.sustainedPeakDb + profile.splOffset)
      }
    ])
    finishTurn({ turn: t, value: score.score, score, isRecord })
  }

  const runSilence = (t: Turn): Promise<void> =>
    new Promise((resolve) => {
      const watcher = new SilenceWatcher(profile.noiseFloorDb)
      const limit = settings.silenceMaxSeconds * 1000
      let done = false
      const end = (): void => {
        if (done) return
        done = true
        off()
        clearInterval(timer)
        const survived = Math.min(limit, watcher.survivedMs(performance.now())) / 1000
        if (alive.current) finishTurn({ turn: t, value: Math.round(survived * 10) / 10, isRecord: false })
        resolve()
      }
      const off = audioEngine.onReading((r) => {
        if (watcher.push(r)) end()
      })
      const start = performance.now()
      const timer = setInterval(() => {
        const ms = performance.now() - start
        setElapsed(ms / 1000)
        if (ms >= limit) end()
      }, 100)
    })

  const runSustain = (t: Turn): Promise<void> =>
    new Promise((resolve) => {
      const watcher = new SustainWatcher(profile.noiseFloorDb, settings.sustainThresholdDb)
      const limit = settings.sustainMaxSeconds * 1000
      let done = false
      const end = (): void => {
        if (done) return
        done = true
        off()
        clearInterval(guard)
        const heldS = Math.min(limit, watcher.heldMs()) / 1000
        if (alive.current) finishTurn({ turn: t, value: Math.round(heldS * 10) / 10, isRecord: false })
        resolve()
      }
      const off = audioEngine.onReading((r) => {
        const ended = watcher.push(r)
        setElapsed(watcher.heldMs(r.t) / 1000)
        if (ended || watcher.heldMs(r.t) >= limit) end()
      })
      // Readings stop if the mic drops out; don't leave the turn hanging
      const guard = setInterval(() => {
        if (audioEngine.state.status !== 'running') end()
      }, 500)
    })

  const finishTurn = (result: LastResult): void => {
    setLast(result)
    setState((s: unknown) => mode.applyResult(s, { playerId: result.turn.playerId, value: result.value }))
    setPhase('result')
    if (result.isRecord) sounds.record()
    else sounds.result()
  }

  const startTurn = useCallback(async () => {
    if (!turn || !player || phase !== 'ready') return
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
    if (turn.kind === 'silence') await runSilence(turn)
    else if (turn.kind === 'sustain') await runSustain(turn)
    else await runScream(turn, player)
  }, [turn, player, phase, engine.status, settings, sounds])

  const next = useCallback(() => {
    if (phase !== 'result') return
    if (mode.nextTurn(state) === null) {
      setPhase('done')
      sounds.win()
    } else {
      setPhase('ready')
    }
  }, [phase, mode, state, sounds])

  useKey('Space', phase === 'ready' ? startTurn : next, phase === 'ready' || phase === 'result')

  useEffect(() => {
    if (phase !== 'done') return
    const colors = [theme.tokens.primary, theme.tokens.accent, theme.tokens.success]
    confetti({ particleCount: 180, spread: 100, origin: { y: 0.6 }, colors })
    const t = setTimeout(() => confetti({ particleCount: 120, spread: 140, origin: { y: 0.4 }, colors }), 700)
    return () => clearTimeout(t)
  }, [phase, theme])

  const rematch = (): void => {
    setState(mode.init(ctx, session.config))
    setLast(null)
    setPhase('ready')
  }

  if (phase === 'done') {
    return (
      <Podium
        standings={standings}
        session={session}
        overlay={overlay}
        setOverlay={setOverlay}
        onRematch={rematch}
        navigate={navigate}
        kind={mode.turnKind}
      />
    )
  }

  const liveLevel = phase === 'result' && last?.score ? Math.min(1, last.score.score / 100) : level
  const liveSpl = reading ? Math.round(reading.smoothedDb + profile.splOffset) : null
  const timedMax = turn?.kind === 'sustain' ? settings.sustainMaxSeconds : settings.silenceMaxSeconds
  const timedRatio = timedMax ? elapsed / timedMax : 0
  const isTimed = turn?.kind === 'silence' || turn?.kind === 'sustain'

  return (
    <div className={`screen game-screen phase-${phase}`}>
      <header className="screen-header">
        <button className="btn ghost" onClick={() => navigate({ name: 'modes' })}>
          ← Salir
        </button>
        <h1 className="screen-title">
          {mode.emoji} {mode.name}
        </h1>
        <div className="screen-actions">
          <span className="chip">{mode.progress(state, ctx)}</span>
        </div>
      </header>

      <div className="game-layout">
        <aside className="game-side">
          {view && <ModeViewPanel view={view} />}
          <h3>Tabla</h3>
          <StandingsList standings={standings} highlight={last?.turn.playerId} />
        </aside>

        <main className="game-stage">
          {player && phase !== 'result' && (
            <div className="turn-card" style={team ? { ['--team' as string]: team.color } : undefined}>
              <MonsterAvatar player={player} size={settings.projectorMode ? 120 : 96} />
              <div>
                {turn?.label && <div className="muted">{turn.label}</div>}
                <div className="turn-name">
                  {isBirthdayPlayer(player, settings.birthdayName) && <span className="crown">👑</span>}
                  {player.name}
                </div>
                {team && <div className="turn-team">{team.name}</div>}
                {multiplier !== 1 && turn?.kind === 'scream' && <div className="chip">Bonus x{multiplier} por edad</div>}
              </div>
            </div>
          )}

          <div className="stage-center">
            <div className="stage-meter">
              {turn?.kind === 'silence' && phase === 'active' ? (
                <Meter level={normalizeLevel(reading?.smoothedDb ?? -100, profile.noiseFloorDb, 20)} held={0} active clipped={reading?.clipped} />
              ) : (
                <Meter
                  level={liveLevel}
                  held={phase === 'ready' ? 0 : held}
                  active={phase === 'active'}
                  score={phase === 'result' ? last?.value : null}
                  clipped={reading?.clipped}
                />
              )}
            </div>

            <div className="stage-message">
              {phase === 'ready' && (
                <>
                  <p className="big-text">{theme.texts.getReady}</p>
                  <button className="btn primary huge" onClick={startTurn}>
                    {turn?.kind === 'silence' ? '🤫 Empezar silencio' : turn?.kind === 'sustain' ? '⏱️ Empezar grito largo' : `🎤 ${theme.texts.screamCta}`}
                  </button>
                  <p className="muted">o pulsa ESPACIO</p>
                </>
              )}
              {phase === 'countdown' && <div className="countdown" key={count}>{count || '¡YA!'}</div>}
              {phase === 'active' && (
                <>
                  <p className="cta-text">{turn?.kind === 'silence' ? theme.texts.silenceCta : turn?.kind === 'sustain' ? theme.texts.sustainCta : theme.texts.screamCta}</p>
                  {isTimed ? (
                    <p className="big-number">{elapsed.toFixed(1)} s</p>
                  ) : (
                    <div className="progress">
                      <div style={{ width: `${Math.min(100, (elapsed / settings.screamSeconds) * 100)}%` }} />
                    </div>
                  )}
                  {isTimed && (
                    <div className="progress">
                      <div style={{ width: `${Math.min(100, timedRatio * 100)}%` }} />
                    </div>
                  )}
                  {settings.showDb && liveSpl !== null && turn?.kind === 'scream' && <p className="db-live">≈ {liveSpl} dB</p>}
                </>
              )}
              {phase === 'result' && last && (
                <Reveal key={last.turn.playerId + last.value}>
                  <div className="result-card">
                    {last.isRecord && <div className="record-banner">{theme.texts.newRecord}</div>}
                    <p className="muted">{theme.texts.resultTitle}</p>
                    <p className="result-name">{ctx.players.find((p) => p.id === last.turn.playerId)?.name}</p>
                    {last.score ? (
                      <>
                        <p className="result-score">{last.value.toFixed(1)}</p>
                        <p className="result-level">{levelLabel(theme, last.value)}</p>
                        {settings.showDb && (
                          <p className="muted">
                            ≈ {Math.round(last.score.sustainedPeakDb + profile.splOffset)} dB · {Math.round(last.score.voicedRatio * 100)}% del
                            tiempo gritando
                            {last.score.clipped && ' · ⚠️ saturó'}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="result-score">{last.value.toFixed(1)} s</p>
                    )}
                    <button className="btn primary huge" onClick={next}>
                      {mode.nextTurn(state) ? 'Siguiente ➜' : '🏆 Ver ganador'}
                    </button>
                  </div>
                </Reveal>
              )}
              {error && <p className="error">{error}</p>}
              {engine.status !== 'running' && phase === 'ready' && (
                <button className="btn" onClick={() => navigate({ name: 'audio' })}>
                  Configurar micrófono
                </button>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

const PODIUM_LABEL: Record<TurnKind, string> = { scream: 'Grito', silence: 'Silencio', sustain: 'Grito más largo' }

function Podium({
  standings,
  session,
  overlay,
  setOverlay,
  onRematch,
  navigate,
  kind
}: {
  standings: Standing[]
  session: GameSession
  overlay: 'certificate' | 'photo' | null
  setOverlay: (o: 'certificate' | 'photo' | null) => void
  onRematch: () => void
  navigate: Navigate
  kind: TurnKind
}): JSX.Element {
  const { theme, data } = useStore()
  const top = standings.slice(0, 3)
  const winner = top[0]
  const order = [top[1], top[0], top[2]]
  const findPlayer = (id: string): Player | undefined => session.ctx.players.find((p) => p.id === id)
  const detail = winner ? `${PODIUM_LABEL[kind]}: ${winner.display}` : ''

  return (
    <div className="screen podium-screen">
      <h1 className="podium-title">🏆 {theme.texts.winnerTitle}</h1>
      {data.settings.birthdayName && <p className="podium-party">🎂 Cumpleaños de {data.settings.birthdayName}</p>}
      <div className="podium">
        {order.map((s, i) =>
          s ? (
            <div key={s.id} className={`podium-step place-${i === 1 ? 1 : i === 0 ? 2 : 3}`} style={s.color ? { ['--team' as string]: s.color } : undefined}>
              {findPlayer(s.id) ? <MonsterAvatar player={findPlayer(s.id)!} size={i === 1 ? 150 : 100} /> : <div className="team-dot" />}
              <strong>
                {findPlayer(s.id) && isBirthdayPlayer(findPlayer(s.id)!, data.settings.birthdayName) && <span className="crown">👑</span>}
                {s.name}
              </strong>
              <span>{s.display}</span>
              <div className="podium-block">{i === 1 ? 1 : i === 0 ? 2 : 3}</div>
            </div>
          ) : (
            <div key={i} className="podium-step empty" />
          )
        )}
      </div>
      <div className="row center">
        {winner && (
          <>
            <button className="btn primary" onClick={() => setOverlay('certificate')}>
              🏅 Certificado
            </button>
            <button className="btn" onClick={() => setOverlay('photo')}>
              📸 Foto del ganador
            </button>
          </>
        )}
        <button className="btn" onClick={onRematch}>
          🔁 Revancha
        </button>
        <button className="btn" onClick={() => navigate({ name: 'modes' })}>
          Otro reto
        </button>
        <button className="btn ghost" onClick={() => navigate({ name: 'home' })}>
          Inicio
        </button>
      </div>
      {overlay === 'certificate' && winner && <Certificate name={winner.name} detail={detail} onClose={() => setOverlay(null)} />}
      {overlay === 'photo' && winner && <WinnerPhoto name={winner.name} detail={detail} onClose={() => setOverlay(null)} />}
    </div>
  )
}
