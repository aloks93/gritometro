import { getMode } from '../../core/game/registry'
import { Screen } from '../components/Layout'
import type { Navigate } from '../nav'
import { saveFile } from '../storage'
import { useStore } from '../store'

export function RecordsScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update, theme } = useStore()
  const sorted = [...data.records].sort((a, b) => b.score - a.score)

  // Best scream per player for the "hall of fame"
  const bestByPlayer = Object.values(
    sorted.reduce<Record<string, (typeof sorted)[number]>>((acc, r) => {
      if (!acc[r.playerId]) acc[r.playerId] = r
      return acc
    }, {})
  )

  const exportCsv = (): void => {
    const rows = [['Fecha', 'Jugador', 'Puntos', 'dB aprox', 'Reto']]
    data.records.forEach((r) =>
      rows.push([new Date(r.date).toLocaleString('es'), r.playerName, r.score.toFixed(1), String(r.db ?? ''), getMode(r.modeId)?.name ?? r.modeId])
    )
    const csv = rows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\r\n')
    // BOM so Excel opens accents correctly
    saveFile('gritometro-historial.csv', '﻿' + csv)
  }

  return (
    <Screen
      title={`🏆 Récords · ${theme.texts.appTitle}`}
      onBack={() => navigate({ name: 'home' })}
      actions={
        <>
          <button className="btn" onClick={exportCsv} disabled={data.records.length === 0}>
            Exportar CSV
          </button>
          <button className="btn danger" disabled={data.records.length === 0} onClick={() => confirm('¿Borrar todo el historial de gritos?') && update('records', [])}>
            Borrar
          </button>
        </>
      }
    >
      {bestByPlayer.length === 0 ? (
        <p className="muted center-text">Todavía nadie ha gritado. ¡Ve a jugar!</p>
      ) : (
        <table className="records-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Jugador</th>
              <th>Mejor grito</th>
              <th>dB aprox.</th>
              <th>Reto</th>
              <th>Hora</th>
            </tr>
          </thead>
          <tbody>
            {bestByPlayer.slice(0, 30).map((r, i) => (
              <tr key={r.id} className={i < 3 ? `top-${i + 1}` : ''}>
                <td>{['🥇', '🥈', '🥉'][i] ?? i + 1}</td>
                <td>{r.playerName}</td>
                <td>
                  <strong>{r.score.toFixed(1)}</strong>
                </td>
                <td>{r.db ?? '—'}</td>
                <td>{getMode(r.modeId)?.name ?? r.modeId}</td>
                <td>{new Date(r.date).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">Total de gritos registrados: {data.records.length}</p>
    </Screen>
  )
}
