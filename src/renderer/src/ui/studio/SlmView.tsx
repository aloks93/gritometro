import { useEffect, useRef, useState } from 'react'
import { activeProfile } from '../../core/audio/AudioConfig'
import { calibrationWarnings } from '../../core/studio/calibration'
import { type TimeWeighting, type Weighting } from '../../core/studio/loudness'
import { saveFile } from '../storage'
import { useEngineState } from '../hooks'
import { useStore } from '../store'
import { useSoundLevel, type SlmSample } from './meters'
import { useStudioPrefs } from './MonitorView'
import { fitCanvas, fmtTime, Readout, Segmented } from './widgets'

const HISTORY_S = 120

/** Sound level meter (sonómetro): A/C/Z, Fast/Slow, Leq, Lmax/Lmin, LCpeak, history and calibration */
export function SlmView(): JSX.Element {
  const { data } = useStore()
  const [prefs, setPrefs] = useStudioPrefs()
  const engine = useEngineState()
  const profile = activeProfile(data.audio)
  const w = prefs.slmWeighting
  const tw = prefs.slmTime
  const { reading, history, reset } = useSoundLevel(profile.splOffset, w, HISTORY_S)
  const [log, setLog] = useState<{ t: string; leq: number; max: number; peak: number }[]>([])

  const now = reading ? (tw === 'F' ? reading.fast[w] : reading.slow[w]) : null
  const label = `L${w}${tw}`

  const calibration = data.studio.calibrations[profile.id]?.find((h) => h.method !== 'loopback')
  const calWarnings = calibrationWarnings(calibration, { deviceLabel: engine.status === 'running' ? engine.label : undefined, gainDb: profile.gainDb, offsetDb: profile.splOffset })

  const snapshot = (): void => {
    if (!reading) return
    setLog((l) => [...l, { t: new Date().toLocaleTimeString('es'), leq: reading.leq[w], max: reading.max[w], peak: reading.peakC }])
  }

  const exportCsv = (): void => {
    const rows = [['Hora', `L${w}eq dB`, `L${w}Fmax dB`, 'LCpeak dB'], ...log.map((r) => [r.t, r.leq, r.max, r.peak].map((v) => String(v).replace('.', ',')))]
    saveFile('sonometro.csv', '﻿' + rows.map((r) => r.map((c) => `"${c}"`).join(';')).join('\r\n'))
  }

  return (
    <div className="st-slm">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Sonómetro</h2>
          <div className="st-row">
            <Segmented<Weighting> value={w} onChange={(v) => setPrefs({ slmWeighting: v })} options={[['A', 'A'], ['C', 'C'], ['Z', 'Z (plano)']]} title="Ponderación de frecuencia" />
            <Segmented<TimeWeighting> value={tw} onChange={(v) => setPrefs({ slmTime: v })} options={[['F', 'Rápido'], ['S', 'Lento']]} title="Ponderación temporal" />
            <button className="st-btn" onClick={reset}>
              ↺ Reiniciar
            </button>
          </div>
        </header>
        <div className="st-slm-main">
          <div className="st-slm-big">
            <small>{label}</small>
            <b className={now !== null && now > 100 ? 'bad' : now !== null && now > 85 ? 'warn' : ''}>{now !== null && engine.status === 'running' ? now.toFixed(1) : '—'}</b>
            <i>dB SPL</i>
          </div>
          <div className="st-readouts st-grow">
            <Readout label={`L${w}eq`} value={reading ? reading.leq[w].toFixed(1) : '—'} unit="dB" big />
            <Readout label={`L${w}Fmax`} value={reading ? reading.max[w].toFixed(1) : '—'} unit="dB" />
            <Readout label={`L${w}Fmin`} value={reading ? reading.min[w].toFixed(1) : '—'} unit="dB" />
            <Readout label="LCpeak" value={reading ? reading.peakC.toFixed(1) : '—'} unit="dB" tone={reading && reading.peakC > 135 ? 'bad' : ''} />
            <Readout label="LAeq · LCeq" value={reading ? `${reading.leq.A.toFixed(0)} · ${reading.leq.C.toFixed(0)}` : '—'} unit="dB" />
            <Readout label="LCeq − LAeq" value={reading ? (reading.leq.C - reading.leq.A).toFixed(1) : '—'} unit="dB" />
            <Readout label="Tiempo" value={reading ? fmtTime(reading.durationS) : '—'} unit="" />
            <Readout label="Calibración" value={profile.splOffset.toFixed(1)} unit="dB" />
          </div>
        </div>
        <HistoryChart history={history} slow={tw === 'S'} />
        <p className="st-muted st-small">
          Últimos {HISTORY_S / 60} min · línea = {tw === 'F' ? 'rápido (125 ms)' : 'lento (1 s)'}. LCeq − LAeq alto (&gt; 15 dB) indica mucho contenido de graves. Sin calibrar,
          los dB SPL son aproximados.
        </p>
      </section>

      {calWarnings.length > 0 && (
        <ul className="st-warnings">
          {calWarnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
          <li>Calibra o verifica en la pestaña Calibración (Ctrl+4).</li>
        </ul>
      )}

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Registro</h2>
          <div className="st-row">
            <button className="st-btn" disabled={!reading} onClick={snapshot}>
              + Anotar lectura
            </button>
            <button className="st-btn" disabled={log.length === 0} onClick={exportCsv}>
              Exportar CSV
            </button>
            {log.length > 0 && (
              <button className="st-btn ghost" onClick={() => setLog([])}>
                Vaciar
              </button>
            )}
          </div>
        </header>
        {log.length === 0 ? (
          <p className="st-muted st-small">Anota lecturas (Leq, máximo y pico desde el último reinicio) para documentar una medición.</p>
        ) : (
          <table className="st-table">
            <thead>
              <tr>
                <th>Hora</th>
                <th>L{w}eq</th>
                <th>L{w}Fmax</th>
                <th>LCpeak</th>
              </tr>
            </thead>
            <tbody>
              {log.map((r, i) => (
                <tr key={i}>
                  <td>{r.t}</td>
                  <td>{r.leq.toFixed(1)}</td>
                  <td>{r.max.toFixed(1)}</td>
                  <td>{r.peak.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function HistoryChart({ history, slow }: { history: SlmSample[]; slow: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const data = useRef(history)
  data.current = history
  const mode = useRef(slow)
  mode.current = slow
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      const dpr = devicePixelRatio
      g.clearRect(0, 0, w, h)
      const pts = data.current
      const values = pts.map((p) => (mode.current ? p.slow : p.fast))
      const hi = Math.ceil((Math.max(60, ...values) + 5) / 10) * 10
      const lo = Math.max(0, hi - 70)
      const y = (v: number): number => h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h
      g.font = `${11 * dpr}px Consolas, monospace`
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.fillStyle = css.getPropertyValue('--st-muted')
      for (let v = lo; v <= hi; v += 10) {
        g.beginPath()
        g.moveTo(0, y(v))
        g.lineTo(w, y(v))
        g.stroke()
        g.fillText(String(v), 3, y(v) - 3)
      }
      if (pts.length < 2) return
      const now = pts[pts.length - 1].t
      const x = (t: number): number => w - ((now - t) / (HISTORY_S * 1000)) * w
      g.beginPath()
      pts.forEach((p, i) => {
        const v = mode.current ? p.slow : p.fast
        if (i === 0) g.moveTo(x(p.t), y(v))
        else g.lineTo(x(p.t), y(v))
      })
      g.strokeStyle = css.getPropertyValue('--st-accent')
      g.lineWidth = 1.5 * dpr
      g.stroke()
      g.lineWidth = 1
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="st-canvas" style={{ height: 180 }} />
}
