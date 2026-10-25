import { useEffect, useRef, useState } from 'react'
import confetti from 'canvas-confetti'
import { allOut, blowCandles, lightCandles } from '../../core/party/candles'
import { useEngineState, useKey, useLevel } from '../hooks'
import type { Navigate } from '../nav'
import { useSounds } from '../sound'
import { useStore } from '../store'

/** Level used when blowing by holding SPACE / the mouse (mic fallback) */
const MANUAL_BLOW = 0.6

/** Virtual birthday cake: blow into the mic to put the candles out */
export function CakeScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, theme } = useStore()
  const sounds = useSounds()
  const engine = useEngineState()
  const { level, reading } = useLevel()
  const { birthdayName, birthdayAge } = data.settings
  const [candles, setCandles] = useState(() => lightCandles(birthdayAge))
  const [manual, setManual] = useState(false)
  const lastT = useRef<number | null>(null)
  const done = allOut(candles)
  const blow = manual ? Math.max(level, MANUAL_BLOW) : level

  // Advance with every mic reading (~60/s); manual blowing ticks on its own timer
  useEffect(() => {
    if (!reading || done) return
    const dt = lastT.current === null ? 16 : reading.t - lastT.current
    lastT.current = reading.t
    setCandles((s) => blowCandles(s, blow, dt))
  }, [reading])

  useEffect(() => {
    if (!manual || done || engine.status === 'running') return
    const t = setInterval(() => setCandles((s) => blowCandles(s, MANUAL_BLOW, 50)), 50)
    return () => clearInterval(t)
  }, [manual, done, engine.status])

  useEffect(() => {
    if (!done) return
    sounds.birthday()
    const colors = [theme.tokens.primary, theme.tokens.accent, theme.tokens.success, '#ffffff']
    confetti({ particleCount: 220, spread: 120, origin: { y: 0.55 }, colors })
    const t = setTimeout(() => confetti({ particleCount: 160, spread: 160, origin: { y: 0.35 }, colors }), 900)
    return () => clearTimeout(t)
  }, [done])

  // Hold SPACE to blow when the mic isn't cooperating
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !e.repeat) setManual(true)
    }
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') setManual(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const relight = (): void => {
    lastT.current = null
    setCandles(lightCandles(birthdayAge))
  }
  useKey('Enter', relight, done)

  const blowing = !done && blow >= 0.3

  return (
    <div className="screen cake-screen">
      <header className="screen-header">
        <button className="btn ghost" onClick={() => navigate({ name: 'home' })}>
          ← Inicio
        </button>
        <h1 className="screen-title">🎂 Sopla las velas</h1>
        <div className="screen-actions">
          <button className="btn" onClick={() => sounds.birthday()}>
            🎵 Cantar
          </button>
        </div>
      </header>

      <div className="cake-stage">
        <p className="big-text cake-message">
          {done ? (
            <>¡Pide un deseo{birthdayName ? `, ${birthdayName}` : ''}! ✨</>
          ) : birthdayName ? (
            <>
              ¡Sopla fuerte, <strong>{birthdayName}</strong>!
            </>
          ) : (
            '¡Sopla fuerte al micrófono!'
          )}
        </p>

        <Cake
          total={candles.total}
          lit={candles.lit}
          wobble={done ? 0 : Math.min(1, blow / 0.6)}
          onPointerDown={() => setManual(true)}
          onPointerUp={() => setManual(false)}
        />

        <div className="cake-progress">
          <span className="chip">
            {candles.lit === 0 ? '¡Todas apagadas!' : `${candles.total - candles.lit} de ${candles.total} apagadas`}
          </span>
          {blowing && <span className="chip cake-wind">💨 ¡Así!</span>}
        </div>

        {done ? (
          <div className="row center">
            <button className="btn primary huge" onClick={relight}>
              🕯️ Encender otra vez
            </button>
            <button className="btn" onClick={() => navigate({ name: 'modes' })}>
              🎮 A jugar
            </button>
          </div>
        ) : (
          <p className="muted">
            {engine.status === 'running'
              ? 'Sopla cerca del micrófono. Si no funciona, mantén pulsado ESPACIO o el pastel.'
              : 'Micrófono apagado: mantén pulsado ESPACIO o el pastel para soplar.'}
          </p>
        )}
      </div>
    </div>
  )
}

function Cake({
  total,
  lit,
  wobble,
  onPointerDown,
  onPointerUp
}: {
  total: number
  lit: number
  /** 0..1: how hard the flames are being blown sideways */
  wobble: number
  onPointerDown: () => void
  onPointerUp: () => void
}): JSX.Element {
  const W = 420
  const top = { x: 90, w: 240, y: 150 }
  const gap = top.w / (total + 1)
  // Candles go out from the right
  return (
    <svg
      className="cake"
      viewBox={`0 0 ${W} 360`}
      style={{ ['--wobble' as string]: wobble }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <ellipse cx={W / 2} cy={338} rx={190} ry={16} className="cake-plate" />
      {/* bottom tier */}
      <rect x={50} y={230} width={320} height={105} rx={14} className="cake-tier" />
      <path d="M50 244 q20 22 40 0 q20 22 40 0 q20 22 40 0 q20 22 40 0 q20 22 40 0 q20 22 40 0 q20 22 40 0 q20 22 40 0 V236 a14 14 0 0 0 -14 -6 H64 a14 14 0 0 0 -14 6 Z" className="cake-icing" />
      {/* top tier */}
      <rect x={top.x} y={top.y} width={top.w} height={84} rx={12} className="cake-tier alt" />
      <path d={`M${top.x} ${top.y + 12} q15 18 30 0 q15 18 30 0 q15 18 30 0 q15 18 30 0 q15 18 30 0 q15 18 30 0 q15 18 30 0 q15 18 30 0 V${top.y + 6} a12 12 0 0 0 -12 -6 H${top.x + 12} a12 12 0 0 0 -12 6 Z`} className="cake-icing" />
      {[70, 130, 190, 250, 310, 350].map((x, i) => (
        <circle key={i} cx={x} cy={290 + (i % 2) * 18} r={6} className={`cake-sprinkle s${i % 3}`} />
      ))}
      {Array.from({ length: total }, (_, i) => {
        const x = top.x + gap * (i + 1)
        const on = i < lit
        return (
          <g key={i} className={`candle ${on ? 'on' : 'out'}`} style={{ ['--i' as string]: i }}>
            <rect x={x - 5} y={top.y - 46} width={10} height={48} rx={3} className={`candle-stick c${i % 4}`} />
            <line x1={x} y1={top.y - 46} x2={x} y2={top.y - 54} className="candle-wick" />
            {on ? (
              <g className="flame" style={{ transformOrigin: `${x}px ${top.y - 54}px` }}>
                <ellipse cx={x} cy={top.y - 66} rx={8} ry={14} className="flame-outer" />
                <ellipse cx={x} cy={top.y - 62} rx={4} ry={8} className="flame-inner" />
              </g>
            ) : (
              <circle cx={x} cy={top.y - 62} r={6} className="smoke" />
            )}
          </g>
        )
      })}
    </svg>
  )
}
