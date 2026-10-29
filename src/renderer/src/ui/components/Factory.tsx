import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import confetti from 'canvas-confetti'
import { screamTitle, topScreamers, type LeaderEntry, type ScoreRecord } from '../../core/game/leaderboard'
import type { Player } from '../../core/players/players'
import { MonsterAvatar } from './MonsterAvatar'

/** The funny title for a score, big and loud on the result card */
export function ScreamTitleBadge({ score }: { score: number }): JSX.Element {
  const t = screamTitle(score)
  return (
    <div className="scream-title" key={t.label}>
      <span className="scream-title-emoji">{t.emoji}</span>
      <span>{t.label}</span>
    </div>
  )
}

/** Employee ID card: photo, name, age, badge number and personal best */
export function EmployeeBadge({ player, factory, best, compact }: { player: Player; factory: string; best?: number; compact?: boolean }): JSX.Element {
  return (
    <div className={`employee-badge ${compact ? 'compact' : ''}`}>
      <div className="badge-head">
        <span>Carnet de empleado</span>
        <small>{factory}</small>
      </div>
      <MonsterAvatar player={player} size={compact ? 84 : 150} />
      <div className="badge-name">{player.name}</div>
      <dl className="badge-data">
        <dt>Nº de empleado</dt>
        <dd>{player.code || '—'}</dd>
        <dt>Edad</dt>
        <dd>{player.age ? `${player.age} años` : '—'}</dd>
        {best !== undefined && (
          <>
            <dt>Mejor grito</dt>
            <dd>
              {best.toFixed(1)} {screamTitle(best).emoji}
            </dd>
          </>
        )}
      </dl>
    </div>
  )
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']

/** On-screen number pad for the badge code (the physical keyboard works too) */
export function Keypad({
  value,
  onChange,
  onSubmit,
  error,
  enabled = true
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  error?: string
  enabled?: boolean
}): JSX.Element {
  const press = (k: string): void => {
    if (k === 'del') onChange(value.slice(0, -1))
    else if (k === 'ok') onSubmit()
    else if (value.length < 12) onChange(value + k)
  }
  const pressRef = useRef(press)
  pressRef.current = press

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.altKey || e.metaKey) return
      let k: string | null = null
      if (/^[0-9a-z]$/i.test(e.key)) k = e.key.toUpperCase()
      else if (e.key === 'Backspace') k = 'del'
      else if (e.key === 'Enter') k = 'ok'
      if (!k) return
      e.preventDefault()
      pressRef.current(k)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])

  return (
    <div className="keypad">
      <div className={`keypad-display ${error ? 'error' : ''}`} key={error}>
        {value || <span className="muted">Nº de carnet</span>}
      </div>
      <div className="keypad-keys">
        {KEYS.map((k) => (
          <button key={k} className={`btn keypad-key ${k === 'ok' ? 'primary' : ''}`} disabled={k === 'ok' && !value} onClick={() => press(k)}>
            {k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

const MEDALS = ['🥇', '🥈', '🥉']

/**
 * Permanent TOP 10 (best scream per player). Rows that climb flash, and a new first place
 * gets a full-screen "new leader" announcement.
 */
export const Leaderboard = memo(function Leaderboard({
  records,
  players,
  highlight,
  colors
}: {
  records: ScoreRecord[]
  players: Player[]
  highlight?: string
  colors?: string[]
}): JSX.Element {
  const top = useMemo(() => topScreamers(records, players, 10), [records, players])
  const prev = useRef<LeaderEntry[] | null>(null)
  const [movers, setMovers] = useState<Record<string, number | 'new'>>({})
  const [leader, setLeader] = useState<LeaderEntry | null>(null)

  useEffect(() => {
    const before = prev.current
    prev.current = top
    if (!before) return
    const old = new Map(before.map((e, i) => [e.key, { rank: i, score: e.score }]))
    // Only a better scream moves someone up (deleting records or renaming doesn't)
    const moved: Record<string, number | 'new'> = {}
    top.forEach((e, i) => {
      const o = old.get(e.key)
      if (!o) moved[e.key] = 'new'
      else if (o.rank > i && e.score > o.score) moved[e.key] = o.rank - i
    })
    if (Object.keys(moved).length) {
      setMovers(moved)
      const t = setTimeout(() => setMovers({}), 3000)
      if (top[0] && before[0] && top[0].key !== before[0].key && top[0].score > before[0].score) setLeader(top[0])
      return () => clearTimeout(t)
    }
  }, [top])

  useEffect(() => {
    if (!leader) return
    const shoot = (): void => void confetti({ particleCount: 160, spread: 120, origin: { y: 0.35 }, colors, zIndex: 1000 })
    shoot()
    const again = setTimeout(shoot, 900)
    const hide = setTimeout(() => setLeader(null), 4500)
    return () => {
      clearTimeout(again)
      clearTimeout(hide)
    }
  }, [leader])

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players])

  return (
    <div className="leaderboard">
      <h3 className="leaderboard-title">🏆 TOP 10</h3>
      {top.length === 0 ? (
        <p className="muted">Todavía nadie gritó.</p>
      ) : (
        <ol className="leaderboard-list">
          {top.map((e, i) => {
            const p = byId.get(e.playerId)
            const gained = movers[e.key]
            return (
              <li key={e.key} className={`${i < 3 ? `top-${i + 1}` : ''} ${gained ? 'rank-up' : ''} ${e.playerId === highlight ? 'highlight' : ''}`}>
                <span className="lb-rank">{MEDALS[i] ?? i + 1}</span>
                {p && <MonsterAvatar player={p} size={30} />}
                <span className="lb-name">{e.name}</span>
                {gained && <span className="lb-up">{gained === 'new' ? '¡NUEVO!' : `▲${gained}`}</span>}
                <span className="lb-score">
                  {e.score.toFixed(1)} <small>{screamTitle(e.score).emoji}</small>
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {leader &&
        createPortal(
          <div className="new-leader" onClick={() => setLeader(null)}>
            <div className="new-leader-card">
              <div className="new-leader-crown">👑</div>
              <p className="new-leader-kicker">¡Nuevo líder de la fábrica!</p>
              {byId.get(leader.playerId) && <MonsterAvatar player={byId.get(leader.playerId)!} size={160} />}
              <p className="new-leader-name">{leader.name}</p>
              <p className="new-leader-score">{leader.score.toFixed(1)} pts</p>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
})
