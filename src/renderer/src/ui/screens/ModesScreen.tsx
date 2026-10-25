import { useMemo, useState } from 'react'
import { gameModes } from '../../core/game/registry'
import { autoTeams, type Team } from '../../core/players/players'
import { Field, Panel, Screen } from '../components/Layout'
import { MonsterAvatar } from '../components/MonsterAvatar'
import type { Navigate } from '../nav'
import { useStore } from '../store'

export function ModesScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data } = useStore()
  const [modeId, setModeId] = useState(gameModes[0].id)
  const mode = gameModes.find((m) => m.id === modeId)!
  const [configs, setConfigs] = useState<Record<string, Record<string, number>>>({})
  const config = { ...mode.defaultConfig, ...configs[modeId] }
  const [selected, setSelected] = useState<string[]>(data.players.map((p) => p.id))
  const [teamCount, setTeamCount] = useState(2)
  const [teams, setTeams] = useState<Team[]>([])

  const participants = useMemo(() => data.players.filter((p) => selected.includes(p.id)), [data.players, selected])
  const limited = mode.maxPlayers ? participants.slice(0, mode.maxPlayers) : participants

  // Keep team assignments in sync with the participants
  const activeTeams = useMemo(() => {
    if (!mode.usesTeams) return []
    const valid = teams.length === teamCount && participants.every((p) => teams.some((t) => t.playerIds.includes(p.id)))
    const base = valid ? teams : autoTeams(participants, teamCount)
    return base.map((t) => ({ ...t, playerIds: t.playerIds.filter((id) => selected.includes(id)) }))
  }, [mode.usesTeams, teams, teamCount, participants, selected])

  const toggle = (id: string): void =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const moveTo = (playerId: string, teamId: string): void =>
    setTeams(activeTeams.map((t) => ({ ...t, playerIds: t.id === teamId ? [...t.playerIds.filter((x) => x !== playerId), playerId] : t.playerIds.filter((x) => x !== playerId) })))

  const problems: string[] = []
  if (limited.length < mode.minPlayers) problems.push(`Este reto necesita al menos ${mode.minPlayers} jugadores.`)
  if (mode.maxPlayers && participants.length > mode.maxPlayers) problems.push(`Solo juegan los primeros ${mode.maxPlayers} seleccionados.`)
  if (mode.usesTeams && activeTeams.filter((t) => t.playerIds.length > 0).length < 2) problems.push('Se necesitan al menos 2 equipos con jugadores.')
  const blocking = problems.filter((p) => !p.startsWith('Solo'))

  const start = (): void => {
    navigate({
      name: 'game',
      session: { modeId, config, ctx: { players: limited, teams: mode.usesTeams ? activeTeams : [] } }
    })
  }

  return (
    <Screen
      title="🎯 Elige el reto"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <button className="btn primary" disabled={blocking.length > 0} onClick={start}>
          ¡Empezar! ➜
        </button>
      }
    >
      <div className="mode-grid">
        {gameModes.map((m) => (
          <button key={m.id} className={`mode-card ${m.id === modeId ? 'selected' : ''}`} onClick={() => setModeId(m.id)}>
            <span className="mode-emoji">{m.emoji}</span>
            <strong>{m.name}</strong>
            <small>{m.description}</small>
          </button>
        ))}
      </div>

      <div className="two-col">
        <Panel title={`¿Quién juega? (${participants.length})`}>
          <div className="pick-grid">
            {data.players.map((p) => (
              <button key={p.id} className={`pick ${selected.includes(p.id) ? 'on' : ''}`} onClick={() => toggle(p.id)}>
                <MonsterAvatar player={p} size={44} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <div className="row">
            <button className="btn small" onClick={() => setSelected(data.players.map((p) => p.id))}>
              Todos
            </button>
            <button className="btn small" onClick={() => setSelected([])}>
              Ninguno
            </button>
            <button className="btn small" onClick={() => navigate({ name: 'players' })}>
              Editar jugadores
            </button>
          </div>
        </Panel>

        <Panel title="Opciones del reto">
          {mode.configFields.map((f) => (
            <Field key={f.key} label={f.label}>
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step ?? 1}
                value={config[f.key]}
                onChange={(e) =>
                  setConfigs((c) => ({ ...c, [modeId]: { ...config, [f.key]: Math.min(f.max, Math.max(f.min, Number(e.target.value))) } }))
                }
              />
            </Field>
          ))}
          {mode.usesTeams && (
            <>
              <Field label="Número de equipos">
                <input type="number" min={2} max={4} value={teamCount} onChange={(e) => setTeamCount(Math.min(4, Math.max(2, Number(e.target.value))))} />
              </Field>
              <button className="btn small" onClick={() => setTeams(autoTeams(participants, teamCount))}>
                🔀 Repartir automáticamente
              </button>
              <div className="teams-edit">
                {activeTeams.map((t) => (
                  <div key={t.id} className="team-col" style={{ borderColor: t.color }}>
                    <strong style={{ color: t.color }}>{t.name}</strong>
                    {t.playerIds.map((pid) => {
                      const p = data.players.find((x) => x.id === pid)!
                      return (
                        <div key={pid} className="team-member">
                          <span>{p.name}</span>
                          <select value={t.id} onChange={(e) => moveTo(pid, e.target.value)}>
                            {activeTeams.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
          {problems.map((p) => (
            <p key={p} className={blocking.includes(p) ? 'error' : 'muted'}>
              {p}
            </p>
          ))}
        </Panel>
      </div>
    </Screen>
  )
}
