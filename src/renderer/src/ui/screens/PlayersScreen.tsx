import { useState, type FormEvent } from 'react'
import { createPlayer, handicapFor, randomAvatar, type Player } from '../../core/players/players'
import { Panel, Screen } from '../components/Layout'
import { MonsterAvatar } from '../components/MonsterAvatar'
import type { Navigate } from '../nav'
import { readImageScaled } from '../storage'
import { useStore } from '../store'

export function PlayersScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update } = useStore()
  const [name, setName] = useState('')
  const [age, setAge] = useState('')

  const add = (e: FormEvent): void => {
    e.preventDefault()
    if (!name.trim()) return
    update('players', (ps) => [...ps, createPlayer(name, age ? Number(age) : undefined)])
    setName('')
    setAge('')
  }

  const edit = (id: string, patch: Partial<Player>): void =>
    update('players', (ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const remove = (id: string): void => update('players', (ps) => ps.filter((p) => p.id !== id))

  const uploadPhoto = async (id: string, file?: File): Promise<void> => {
    if (file) edit(id, { photo: await readImageScaled(file, 320) })
  }

  return (
    <Screen
      title="👾 Jugadores"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <button className="btn primary" disabled={data.players.length === 0} onClick={() => navigate({ name: 'modes' })}>
          Elegir reto ➜
        </button>
      }
    >
      <Panel title="Agregar jugador">
        <form className="row" onSubmit={add}>
          <input autoFocus placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
          <input type="number" placeholder="Edad (opcional)" value={age} min={1} max={99} onChange={(e) => setAge(e.target.value)} style={{ width: 150 }} />
          <button className="btn primary" type="submit">
            + Agregar
          </button>
        </form>
        <p className="field-hint">La edad se usa para el bonus de los más peques (configurable en Ajustes).</p>
      </Panel>

      <div className="player-grid">
        {data.players.map((p) => {
          const bonus = handicapFor(p.age, data.settings.handicapRules, data.settings.handicapEnabled)
          return (
            <div key={p.id} className="player-card">
              <button className="avatar-btn" title="Cambiar monstruo" onClick={() => edit(p.id, { avatar: randomAvatar(), photo: undefined })}>
                <MonsterAvatar player={p} size={90} />
              </button>
              <input value={p.name} onChange={(e) => edit(p.id, { name: e.target.value })} maxLength={24} />
              <input
                type="number"
                placeholder="Edad"
                value={p.age ?? ''}
                min={1}
                max={99}
                onChange={(e) => edit(p.id, { age: e.target.value ? Number(e.target.value) : undefined })}
              />
              {bonus !== 1 && <span className="chip">Bonus x{bonus}</span>}
              <div className="row">
                <label className="btn small">
                  📷 Foto
                  <input type="file" accept="image/*" hidden onChange={(e) => uploadPhoto(p.id, e.target.files?.[0])} />
                </label>
                <button className="btn small danger" onClick={() => remove(p.id)}>
                  Quitar
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {data.players.length === 0 && <p className="muted center-text">Agrega a los niños de la fiesta para empezar.</p>}
      {data.players.length > 0 && (
        <button className="btn ghost small" onClick={() => confirm('¿Borrar a todos los jugadores?') && update('players', [])}>
          Borrar todos
        </button>
      )}
    </Screen>
  )
}
