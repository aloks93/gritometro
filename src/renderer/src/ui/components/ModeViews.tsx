import { memo } from 'react'
import type { ModeView, Standing } from '../../core/game/GameMode'
import { Meter } from './Meter'

// Memoized: the game screen re-renders on every meter frame, these only change per turn
export const StandingsList = memo(function StandingsList({ standings, highlight }: { standings: Standing[]; highlight?: string }): JSX.Element {
  if (standings.length === 0) return <p className="muted">Aún no hay resultados.</p>
  return (
    <ol className="standings">
      {standings.map((s, i) => (
        <li key={s.id} className={s.id === highlight ? 'highlight' : ''} style={s.color ? { borderLeftColor: s.color } : undefined}>
          <span className="standing-rank">{i + 1}</span>
          <span className="standing-name">{s.name}</span>
          <span className="standing-value">{s.display}</span>
        </li>
      ))}
    </ol>
  )
})

export const ModeViewPanel = memo(function ModeViewPanel({ view }: { view: ModeView }): JSX.Element {
  if (view.type === 'bracket') {
    return (
      <div className="bracket">
        {view.rounds.map((round) => (
          <div key={round.name} className="bracket-round">
            <h3>{round.name}</h3>
            {round.matches.map((m, i) => (
              <div key={i} className="bracket-match">
                <div className={m.winner === m.a ? 'won' : ''}>
                  <span>{m.a}</span>
                  <b>{m.scoreA?.toFixed(1) ?? ''}</b>
                </div>
                <div className={m.winner === m.b ? 'won' : ''}>
                  <span>{m.b}</span>
                  <b>{m.scoreB?.toFixed(1) ?? ''}</b>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }
  if (view.type === 'tanks') {
    return (
      <div className="tanks">
        {view.tanks.map((t) => {
          const ratio = Math.min(1, t.fill / t.capacity)
          return (
            <div key={t.id} className="tank-team" style={{ ['--team' as string]: t.color }}>
              <Meter level={ratio} held={0} active={false} compact score={null} />
              <strong>{t.name}</strong>
              <span>
                {Math.round(t.fill)} / {t.capacity}
              </span>
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="duel-board">
      <div>
        <strong>{view.a.name}</strong>
        <span className="duel-score">{view.a.display}</span>
      </div>
      <span className="duel-vs">VS</span>
      <div>
        <strong>{view.b.name}</strong>
        <span className="duel-score">{view.b.display}</span>
      </div>
      <small className="muted">Al mejor de {view.bestOf}</small>
    </div>
  )
})
