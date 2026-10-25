import { useEffect, useState } from 'react'
import { defaultGameSettings, type GameSettings } from '../../core/settings/settings'
import { Field, Panel, Screen, Slider } from '../components/Layout'
import type { Navigate } from '../nav'
import { api } from '../storage'
import { useStore } from '../store'

export function SettingsScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update } = useStore()
  const s = data.settings
  const [dataPath, setDataPath] = useState('')
  useEffect(() => {
    api()?.storage.path().then(setDataPath)
  }, [])

  const set = (patch: Partial<GameSettings>): void => update('settings', (prev) => ({ ...prev, ...patch }))
  const setRule = (i: number, patch: Partial<GameSettings['handicapRules'][number]>): void =>
    set({ handicapRules: s.handicapRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })

  return (
    <Screen
      title="⚙️ Ajustes del juego"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <button className="btn ghost" onClick={() => confirm('¿Restaurar los ajustes del juego?') && update('settings', defaultGameSettings())}>
          Restaurar
        </button>
      }
    >
      <div className="two-col">
        <Panel title="Turnos">
          <Field label="Cuenta regresiva">
            <Slider value={s.countdownSeconds} min={1} max={5} onChange={(v) => set({ countdownSeconds: v })} format={(v) => `${v} s`} />
          </Field>
          <Field label="Duración del grito">
            <Slider value={s.screamSeconds} min={1} max={10} step={0.5} onChange={(v) => set({ screamSeconds: v })} format={(v) => `${v} s`} />
          </Field>
          <Field label="Máximo del reto del silencio">
            <Slider value={s.silenceMaxSeconds} min={5} max={120} step={5} onChange={(v) => set({ silenceMaxSeconds: v })} format={(v) => `${v} s`} />
          </Field>
        </Panel>

        <Panel title="Puntuación">
          <Field label="Dificultad" hint="dB por encima del ruido necesarios para 100 puntos. Menos = más fácil llegar a 100.">
            <Slider value={s.rangeDb} min={20} max={80} onChange={(v) => set({ rangeDb: v })} format={(v) => `${v} dB`} />
          </Field>
          <Field label="Anti-trampa" hint="El grito debe sostenerse este tiempo para contar. Evita golpes al micrófono y aplausos.">
            <Slider value={s.minBurstMs} min={50} max={600} step={50} onChange={(v) => set({ minBurstMs: v })} format={(v) => `${v} ms`} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={s.handicapEnabled} onChange={(e) => set({ handicapEnabled: e.target.checked })} />
            Bonus por edad para los más peques
          </label>
          {s.handicapEnabled && (
            <div className="rules">
              {s.handicapRules.map((r, i) => (
                <div key={i} className="row">
                  <span>Hasta</span>
                  <input type="number" min={1} max={99} value={r.maxAge} onChange={(e) => setRule(i, { maxAge: Number(e.target.value) })} style={{ width: 70 }} />
                  <span>años → x</span>
                  <input type="number" min={1} max={3} step={0.05} value={r.multiplier} onChange={(e) => setRule(i, { multiplier: Number(e.target.value) })} style={{ width: 80 }} />
                  <button className="btn small ghost" onClick={() => set({ handicapRules: s.handicapRules.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn small" onClick={() => set({ handicapRules: [...s.handicapRules, { maxAge: 10, multiplier: 1.1 }] })}>
                + Regla
              </button>
            </div>
          )}
        </Panel>

        <Panel title="Pantalla y sonido">
          <label className="check">
            <input type="checkbox" checked={s.soundEnabled} onChange={(e) => set({ soundEnabled: e.target.checked })} />
            Efectos de sonido
          </label>
          <label className="check">
            <input type="checkbox" checked={s.projectorMode} onChange={(e) => set({ projectorMode: e.target.checked })} />
            Modo proyector / TV (letras grandes)
          </label>
          <label className="check">
            <input type="checkbox" checked={s.showDb} onChange={(e) => set({ showDb: e.target.checked })} />
            Mostrar decibeles aproximados
          </label>
          <p className="field-hint">Atajos: ESPACIO inicia el turno / pasa al siguiente · F11 pantalla completa.</p>
        </Panel>

        <Panel title="Datos">
          <p className="muted">Jugadores, récords, temas y ajustes se guardan en:</p>
          <code className="path">{dataPath || 'almacenamiento del navegador'}</code>
        </Panel>
      </div>
    </Screen>
  )
}
