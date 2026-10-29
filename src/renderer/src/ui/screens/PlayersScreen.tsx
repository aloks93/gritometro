import { useState, type FormEvent } from 'react'
import { screamTitle } from '../../core/game/leaderboard'
import { createPlayer, handicapFor, randomAvatar, type Player } from '../../core/players/players'
import { clashingCodes, mergeRoster, normalizeCode, parseCsv, ROSTER_TEMPLATE_CSV, rowsToRoster } from '../../core/players/roster'
import { readXlsxRows } from '../../core/players/xlsx'
import { Panel, Screen } from '../components/Layout'
import { MonsterAvatar } from '../components/MonsterAvatar'
import type { Navigate } from '../nav'
import { openBinaryFiles, readImageScaled, saveFile } from '../storage'
import { personalBest, useStore } from '../store'

/** CSV text from bytes: UTF-8, or Windows-1252 for files Excel saved as plain "CSV" */
function decodeText(data: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(data)
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(data) : utf8
}

export function PlayersScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update } = useStore()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [age, setAge] = useState('')
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const clashes = clashingCodes(data.players)

  const add = (e: FormEvent): void => {
    e.preventDefault()
    if (!name.trim()) return
    update('players', (ps) => [...ps, { ...createPlayer(name, age ? Number(age) : undefined), code: code.trim() || undefined }])
    setName('')
    setCode('')
    setAge('')
  }

  const edit = (id: string, patch: Partial<Player>): void =>
    update('players', (ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const remove = (id: string): void => update('players', (ps) => ps.filter((p) => p.id !== id))

  const uploadPhoto = async (id: string, file?: File): Promise<void> => {
    if (file) edit(id, { photo: await readImageScaled(file, 320) })
  }

  const importRoster = async (): Promise<void> => {
    setImportMsg(null)
    const [file] = await openBinaryFiles(['xlsx', 'csv', 'txt'], 'Excel o CSV')
    if (!file) return
    try {
      const rows = /\.xlsx$/i.test(file.name) ? await readXlsxRows(file.data) : parseCsv(decodeText(file.data))
      const roster = rowsToRoster(rows)
      if (roster.entries.length === 0) {
        setImportMsg({ ok: false, text: `No encontré invitados en ${file.name}. La planilla necesita columnas Nombre, Código y Edad.` })
        return
      }
      const merged = mergeRoster(data.players, roster.entries)
      update('players', merged.players)
      const notes = [
        `${merged.added} nuevos`,
        `${merged.updated} actualizados`,
        roster.skipped ? `${roster.skipped} filas sin nombre ignoradas` : '',
        roster.duplicateCodes.length ? `código repetido en el archivo: ${roster.duplicateCodes.join(', ')}` : ''
      ].filter(Boolean)
      setImportMsg({ ok: true, text: `✅ ${file.name}: ${notes.join(' · ')}. Ahora solo falta la foto de cada uno.` })
    } catch (err) {
      setImportMsg({ ok: false, text: `No se pudo leer ${file.name}: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  return (
    <Screen
      title="👾 Jugadores"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <>
          <button className="btn" disabled={!data.players.some((p) => p.code)} onClick={() => navigate({ name: 'badge' })}>
            🪪 Turno con carnet
          </button>
          <button className="btn primary" disabled={data.players.length === 0} onClick={() => navigate({ name: 'modes' })}>
            Elegir reto ➜
          </button>
        </>
      }
    >
      <div className="players-top">
        <Panel title="Agregar jugador">
          <form className="row" onSubmit={add}>
            <input autoFocus placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <input placeholder="Nº de carnet" value={code} onChange={(e) => setCode(e.target.value)} maxLength={12} style={{ width: 140 }} />
            <input type="number" placeholder="Edad (opcional)" value={age} min={1} max={99} onChange={(e) => setAge(e.target.value)} style={{ width: 150 }} />
            <button className="btn primary" type="submit">
              + Agregar
            </button>
          </form>
          <p className="field-hint">La edad se usa para el bonus de los más peques (configurable en Ajustes). El Nº de carnet es el que se escribe en el teclado del turno con carnet.</p>
        </Panel>

        <Panel title="Importar invitados">
          <div className="row">
            <button className="btn primary" onClick={importRoster}>
              📥 Importar Excel / CSV
            </button>
            <button className="btn small" onClick={() => saveFile('invitados-plantilla.csv', ROSTER_TEMPLATE_CSV)}>
              Descargar plantilla
            </button>
          </div>
          <p className="field-hint">
            Columnas: <b>Nombre completo</b>, <b>Código</b> y <b>Edad</b> (con títulos en la primera fila, en cualquier orden). Si un código ya existe se
            actualizan sus datos y se conserva la foto.
          </p>
          {importMsg && <p className={importMsg.ok ? 'import-ok' : 'error'}>{importMsg.text}</p>}
        </Panel>
      </div>

      <div className="player-grid">
        {data.players.map((p) => {
          const bonus = handicapFor(p.age, data.settings.handicapRules, data.settings.handicapEnabled)
          const best = personalBest(data.records, p)
          const clash = clashes.has(normalizeCode(p.code))
          return (
            <div key={p.id} className="player-card">
              <button className="avatar-btn" title="Cambiar monstruo" onClick={() => edit(p.id, { avatar: randomAvatar(), photo: undefined })}>
                <MonsterAvatar player={p} size={90} />
              </button>
              <input value={p.name} onChange={(e) => edit(p.id, { name: e.target.value })} maxLength={40} />
              <div className="player-fields">
                <label>
                  <small>Carnet</small>
                  <input
                    className={clash ? 'invalid' : ''}
                    placeholder="—"
                    value={p.code ?? ''}
                    maxLength={12}
                    onChange={(e) => edit(p.id, { code: e.target.value.trim() || undefined })}
                  />
                </label>
                <label>
                  <small>Edad</small>
                  <input
                    type="number"
                    placeholder="—"
                    value={p.age ?? ''}
                    min={1}
                    max={99}
                    onChange={(e) => edit(p.id, { age: e.target.value ? Number(e.target.value) : undefined })}
                  />
                </label>
              </div>
              {clash && <span className="error small-text">Carnet repetido</span>}
              {bonus !== 1 && <span className="chip">Bonus x{bonus}</span>}
              {best !== undefined && (
                <span className="chip" title={screamTitle(best).label}>
                  {screamTitle(best).emoji} Récord {best.toFixed(1)}
                </span>
              )}
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
      {data.players.length === 0 && <p className="muted center-text">Agrega a los niños de la fiesta para empezar, o importa la lista desde Excel.</p>}
      {data.players.length > 0 && (
        <button className="btn ghost small" onClick={() => confirm('¿Borrar a todos los jugadores?') && update('players', [])}>
          Borrar todos
        </button>
      )}
    </Screen>
  )
}
