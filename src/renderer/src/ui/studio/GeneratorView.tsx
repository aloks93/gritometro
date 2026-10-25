import { useEffect, useState } from 'react'
import { audioEngine, joinChunks } from '../../core/audio/AudioEngine'
import { noteName } from '../../core/studio/analysis'
import { clickBurst, findDelay, summarizeLatency } from '../../core/studio/dsp'
import { useEngineState } from '../hooks'
import { generator, type SignalKind, type SignalOptions } from './generator'
import { Readout, Segmented } from './widgets'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Log-scale slider position (0..1000) ↔ 20 Hz–20 kHz
const toHz = (p: number): number => Math.round(20 * Math.pow(1000, p / 1000))
const toPos = (hz: number): number => Math.round((Math.log10(hz / 20) / 3) * 1000)

const PRESETS: [string, Partial<SignalOptions>][] = [
  ['1 kHz −20 dBFS', { kind: 'sine', freqHz: 1000, levelDb: -20 }],
  ['1 kHz −18 dBFS (alineación)', { kind: 'sine', freqHz: 1000, levelDb: -18 }],
  ['100 Hz', { kind: 'sine', freqHz: 100, levelDb: -20 }],
  ['10 kHz', { kind: 'sine', freqHz: 10000, levelDb: -20 }],
  ['Ruido rosa −20', { kind: 'pink', levelDb: -20 }],
  ['Barrido 20 Hz–20 kHz', { kind: 'sweep', levelDb: -20 }]
]

export function GeneratorView(): JSX.Element {
  const [opts, setOpts] = useState<SignalOptions>({ kind: 'sine', freqHz: 1000, levelDb: -20, sweepSeconds: 10 })
  const [on, setOn] = useState(generator.running !== null)

  useEffect(() => {
    if (on) generator.update(opts)
  }, [opts, on])
  // The generator keeps running across tabs on purpose (e.g. pink noise while watching the RTA)

  const toggle = (): void => {
    if (on) generator.stop()
    else generator.start(opts)
    setOn(!on)
  }

  const set = (patch: Partial<SignalOptions>): void => setOpts((o) => ({ ...o, ...patch }))

  return (
    <div className="st-generator">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Generador de señales</h2>
          <button className={`st-btn ${on ? 'rec on' : 'primary'}`} onClick={toggle}>
            {on ? '■ Detener' : '▶ Reproducir'}
          </button>
        </header>
        <div className="st-row">
          <Segmented<SignalKind>
            value={opts.kind}
            onChange={(kind) => set({ kind })}
            options={[
              ['sine', 'Seno'],
              ['square', 'Cuadrada'],
              ['pink', 'Ruido rosa'],
              ['white', 'Ruido blanco'],
              ['sweep', 'Barrido log']
            ]}
          />
        </div>
        {(opts.kind === 'sine' || opts.kind === 'square') && (
          <div className="st-row">
            <label className="st-inline st-grow">
              Frecuencia
              <input className="st-grow" type="range" min={0} max={1000} value={toPos(opts.freqHz)} onChange={(e) => set({ freqHz: toHz(Number(e.target.value)) })} />
            </label>
            <input type="number" min={20} max={20000} value={opts.freqHz} onChange={(e) => set({ freqHz: Math.min(20000, Math.max(20, Number(e.target.value) || 1000)) })} style={{ width: 80 }} />
            Hz <span className="st-muted">{noteName(opts.freqHz)}</span>
          </div>
        )}
        {opts.kind === 'sweep' && (
          <label className="st-inline">
            Duración
            <select value={opts.sweepSeconds} onChange={(e) => set({ sweepSeconds: Number(e.target.value) })}>
              {[5, 10, 20, 30].map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="st-row">
          <label className="st-inline st-grow">
            Nivel
            <input className="st-grow" type="range" min={-60} max={0} value={opts.levelDb} onChange={(e) => set({ levelDb: Number(e.target.value) })} />
          </label>
          <span className="st-mono">{opts.levelDb} dBFS</span>
          {opts.levelDb > -10 && <span className="st-small warn">¡Cuidado con los altavoces y los oídos!</span>}
        </div>
        <div className="st-row">
          <span className="st-muted st-small">Atajos:</span>
          {PRESETS.map(([label, p]) => (
            <button key={label} className="st-btn" onClick={() => set(p)}>
              {label}
            </button>
          ))}
        </div>
        <p className="st-muted st-small">
          El generador sigue sonando aunque cambies de pestaña: pon ruido rosa y mira el RTA del Monitor para ver la respuesta de la sala o del altavoz, o usa un tono de 1 kHz para
          alinear niveles. La salida es la elegida en «Salida de audio».
        </p>
      </section>
      <LatencyPanel />
    </div>
  )
}

/** Round-trip latency: plays clicks through the input's own context and finds them in the recording */
function LatencyPanel(): JSX.Element {
  const engine = useEngineState()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<number[]>([])
  const [msg, setMsg] = useState('')
  const reported = audioEngine.reportedLatency()

  const run = async (): Promise<void> => {
    generator.stop()
    setBusy(true)
    setResults([])
    setMsg('Midiendo… silencio en la sala, por favor')
    const sr = audioEngine.sampleRate
    const click = clickBurst(sr, 0.7)
    const found: number[] = []
    let weak = 0
    for (let i = 0; i < 5; i++) {
      const chunks: { frame: number; data: Float32Array }[] = []
      const off = audioEngine.onPcm((data, frame) => chunks.push({ frame, data }))
      await wait(150)
      const at = audioEngine.scheduleOutput(click, 0.25)
      await wait(1200)
      off()
      if (at === null || chunks.length === 0) break
      const rec = joinChunks(chunks.map((c) => c.data))
      const d = findDelay(rec, click)
      if (d.confidence < 0.35) {
        weak++
        continue
      }
      const frames = chunks[0].frame + d.lag - at
      if (frames > 0) found.push((frames / sr) * 1000)
      setResults([...found])
    }
    setBusy(false)
    if (found.length === 0) setMsg('No se detectó el clic. Une salida y entrada con un cable (loopback) o acerca el micrófono al altavoz y sube el volumen.')
    else setMsg(weak ? `${weak} de 5 clics no se detectaron con claridad.` : '')
  }

  const sum = summarizeLatency(results)
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Latencia de ida y vuelta</h2>
        <button className="st-btn primary" disabled={busy || engine.status !== 'running'} onClick={run}>
          {busy ? `Midiendo… ${results.length}/5` : 'Medir (5 clics)'}
        </button>
      </header>
      <div className="st-readouts">
        <Readout label="Mediana" value={sum ? sum.medianMs.toFixed(1) : '—'} unit="ms" big tone={sum ? (sum.medianMs < 15 ? 'ok' : sum.medianMs < 40 ? 'warn' : 'bad') : ''} />
        <Readout label="Mín. · máx." value={sum ? `${sum.minMs.toFixed(0)} · ${sum.maxMs.toFixed(0)}` : '—'} unit="ms" />
        <Readout label="Variación" value={sum ? sum.jitterMs.toFixed(1) : '—'} unit="ms" />
        <Readout label="Base (navegador)" value={reported ? reported.baseMs.toFixed(1) : '—'} unit="ms" />
        <Readout label="Salida (navegador)" value={reported ? reported.outputMs.toFixed(1) : '—'} unit="ms" />
      </div>
      {msg && <p className="st-small">{msg}</p>}
      <p className="st-muted st-small">
        Mide salida → entrada: reproduce un clic y busca cuándo vuelve por el micrófono. Con un cable de loopback obtienes la latencia de la interfaz; con micrófono y altavoz se suma
        ~3 ms por metro de distancia. Para menos latencia: perfil con latencia «interactive», drivers ASIO/WASAPI del fabricante y buffers pequeños en VoiceMeeter.
      </p>
    </section>
  )
}
