import { useEffect, useRef, useState } from 'react'
import { audioEngine, joinChunks } from '../../core/audio/AudioEngine'
import { mixerEngine, SCOPE_SIZE } from '../../core/audio/MixerEngine'
import { measureRt60, rt60Verdict, type Rt60Result } from '../../core/studio/acoustics'
import { distortionVerdict, measureDistortion, type DistortionResult } from '../../core/studio/distortion'
import { balanceDb, channelOffset, correlationVerdict, goniometer, offsetToCm, phaseCorrelation, type ChannelOffset } from '../../core/studio/stereo'
import { useEngineState } from '../hooks'
import { useStore } from '../store'
import { saveCanvasPng } from './exports'
import { generator } from './generator'
import { useMixerState } from './MixerView'
import { fitCanvas, Readout, Segmented, useInterval } from './widgets'

// Measurement lab: distortion of a test tone, phase/correlation between channels, room RT60.

export function LabView(): JSX.Element {
  // Signals started here must not outlive the tab
  useEffect(() => () => generator.stop(), [])
  return (
    <div className="st-lab">
      <DistortionPanel />
      <PhasePanel />
      <RoomPanel />
    </div>
  )
}

// ---- THD / THD+N

const THD_WINDOW = 32768

function DistortionPanel(): JSX.Element {
  const engine = useEngineState()
  const [measuring, setMeasuring] = useState(false)
  const [tone, setTone] = useState(false)
  const [freq, setFreq] = useState(1000)
  const [level, setLevel] = useState(-12)
  const [result, setResult] = useState<DistortionResult | null>(null)
  const ring = useRef<{ buf: Float32Array; pos: number; filled: number; sr: number }>({ buf: new Float32Array(THD_WINDOW), pos: 0, filled: 0, sr: 48000 })

  useEffect(() => {
    if (!measuring) return
    ring.current.filled = 0
    return audioEngine.onPcm((chunk, _f, sr) => {
      const r = ring.current
      r.sr = sr
      for (let i = 0; i < chunk.length; i++) {
        r.buf[r.pos] = chunk[i]
        r.pos = (r.pos + 1) % r.buf.length
      }
      r.filled = Math.min(r.buf.length, r.filled + chunk.length)
    })
  }, [measuring])

  useInterval(
    () => {
      const r = ring.current
      if (r.filled < r.buf.length) return
      // Unroll the ring so the window is contiguous in time
      const pcm = new Float32Array(r.buf.length)
      pcm.set(r.buf.subarray(r.pos))
      pcm.set(r.buf.subarray(0, r.pos), r.buf.length - r.pos)
      setResult(measureDistortion(pcm, r.sr, tone ? freq : undefined))
    },
    500,
    measuring
  )

  const toggleTone = (): void => {
    if (tone) generator.stop()
    else generator.start({ kind: 'sine', freqHz: freq, levelDb: level, sweepSeconds: 10 })
    setTone(!tone)
  }
  useEffect(() => {
    if (tone) generator.update({ kind: 'sine', freqHz: freq, levelDb: level, sweepSeconds: 10 })
  }, [tone, freq, level])

  const tonePct = (p: number): 'ok' | 'warn' | 'bad' => (p < 0.1 ? 'ok' : p < 1 ? 'warn' : 'bad')
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Distorsión (THD / THD+N)</h2>
        <div className="st-row">
          <button className={`st-btn ${tone ? 'on' : ''}`} onClick={toggleTone}>
            {tone ? '■ Parar tono' : '▶ Tono de prueba'}
          </button>
          <button className={`st-btn ${measuring ? 'on' : 'primary'}`} disabled={engine.status !== 'running'} onClick={() => setMeasuring((m) => !m)}>
            {measuring ? 'Midiendo…' : 'Medir'}
          </button>
        </div>
      </header>
      <div className="st-row">
        <label className="st-inline">
          Frecuencia
          <select value={freq} onChange={(e) => setFreq(Number(e.target.value))}>
            {[100, 440, 1000, 3000].map((f) => (
              <option key={f} value={f}>
                {f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`}
              </option>
            ))}
          </select>
        </label>
        <label className="st-inline">
          Nivel del tono
          <input type="range" min={-40} max={-1} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
          <code>{level} dBFS</code>
        </label>
      </div>
      <div className="st-readouts">
        <Readout label="Fundamental" value={result ? String(result.fundamentalHz) : '—'} unit="Hz" />
        <Readout label="Nivel" value={result ? result.fundamentalDb.toFixed(1) : '—'} unit="dBFS" tone={result && result.fundamentalDb > -1 ? 'bad' : ''} />
        <Readout label="THD" value={result ? fmtPct(result.thdPct) : '—'} unit="%" tone={result ? tonePct(result.thdPct) : ''} />
        <Readout label="THD+N" value={result ? fmtPct(result.thdnPct) : '—'} unit="%" big tone={result ? tonePct(result.thdnPct) : ''} />
        <Readout label="SINAD" value={result ? result.sinadDb.toFixed(1) : '—'} unit="dB" />
      </div>
      {result && (
        <>
          <div className="st-harmonics" title="Nivel de cada armónico respecto a la fundamental">
            {result.harmonics.map((h) => (
              <div key={h.k}>
                <i style={{ height: `${Math.max(0, Math.min(100, ((h.dbc + 120) / 120) * 100))}%` }} />
                <span>H{h.k}</span>
                <small>{h.dbc.toFixed(0)}</small>
              </div>
            ))}
          </div>
          <p className="st-small">{distortionVerdict(result.thdnPct)}</p>
        </>
      )}
      <p className="st-muted st-small">
        {measuring && !result
          ? 'Esperando un tono estable…'
          : 'Mide toda la cadena: salida → altavoz/cable → micro/entrada. Para la interfaz sola, une su salida con su entrada (loopback). THD = armónicos 2…10; THD+N = todo lo que no es el tono, de 20 Hz a 20 kHz.'}
      </p>
    </section>
  )
}

function fmtPct(p: number): string {
  return p < 0.01 ? p.toFixed(4) : p < 1 ? p.toFixed(3) : p.toFixed(2)
}

// ---- Phase / correlation

type PhaseSource = { mode: 'stereo'; kind: 'strip' | 'bus'; id: string } | { mode: 'pair'; a: string; b: string }

function PhasePanel(): JSX.Element {
  const { data, update } = useStore()
  const mixer = useMixerState()
  const cfg = data.mixer
  const [src, setSrc] = useState<PhaseSource>({ mode: 'stereo', kind: 'bus', id: cfg.buses[0]?.id ?? 'A1' })
  const [stats, setStats] = useState<{ corr: number; balance: number; offset: ChannelOffset | null } | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const on = mixer.status === 'on'
  const srcRef = useRef(src)
  srcRef.current = src

  useEffect(() => {
    if (!on) return
    let raf = 0
    let frame = 0
    let corr = 0
    const l = new Float32Array(SCOPE_SIZE)
    const r = new Float32Array(SCOPE_SIZE)
    const tmp = new Float32Array(SCOPE_SIZE)
    const pts = new Float32Array(SCOPE_SIZE * 2)
    const read = (): boolean => {
      const s = srcRef.current
      if (s.mode === 'stereo') return mixerEngine.scope(s.kind, s.id, l, r)
      return mixerEngine.scope('strip', s.a, l, tmp) && mixerEngine.scope('strip', s.b, r, tmp)
    }
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c || !read()) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      g.fillStyle = 'rgba(11, 13, 16, 0.35)'
      g.fillRect(0, 0, w, h)
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(w / 2, 0)
      g.lineTo(w / 2, h)
      g.moveTo(0, h / 2)
      g.lineTo(w, h / 2)
      // L and R axes at ±45°
      g.moveTo(0, 0)
      g.lineTo(w, h)
      g.moveTo(w, 0)
      g.lineTo(0, h)
      g.stroke()
      g.fillStyle = css.getPropertyValue('--st-muted')
      g.font = `${10 * devicePixelRatio}px Consolas, monospace`
      g.fillText(srcRef.current.mode === 'pair' ? 'A' : 'L', 6, 14 * devicePixelRatio)
      g.fillText(srcRef.current.mode === 'pair' ? 'B' : 'R', w - 14 * devicePixelRatio, 14 * devicePixelRatio)
      const n = goniometer(l, r, pts)
      // Auto-gain so quiet sources still fill the scope
      let peak = 0.05
      for (let i = 0; i < n * 2; i++) peak = Math.max(peak, Math.abs(pts[i]))
      const k = (Math.min(w, h) / 2 / peak) * 0.9
      g.fillStyle = css.getPropertyValue('--st-ok')
      for (let i = 0; i < n; i += 2) g.fillRect(w / 2 + pts[i * 2] * k, h / 2 - pts[i * 2 + 1] * k, 1.5 * devicePixelRatio, 1.5 * devicePixelRatio)
      // Correlation like a console meter: smoothed, a few readings per second
      corr = corr * 0.8 + phaseCorrelation(l, r) * 0.2
      if (++frame % 12 === 0) {
        const offset = srcRef.current.mode === 'pair' ? channelOffset(l, r, mixerEngine.state.sampleRate ?? 48000, Math.round((mixerEngine.state.sampleRate ?? 48000) * 0.02)) : null
        setStats({ corr, balance: balanceDb(l, r), offset })
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [on])

  const stereoStrips = cfg.strips.filter((s) => s.input.mode === 'stereo')
  const value = src.mode === 'stereo' ? `${src.kind}|${src.id}` : 'pair'
  const sa = src.mode === 'pair' ? cfg.strips.find((s) => s.id === src.a) : undefined
  const sb = src.mode === 'pair' ? cfg.strips.find((s) => s.id === src.b) : undefined

  /** Delays whichever mic arrives first and flips polarity if needed, so both line up */
  const align = (): void => {
    const o = stats?.offset
    if (!o || !sa || !sb) return
    // Positive lag: B arrives later, so A is the one to delay
    const early = o.ms > 0 ? sa.id : sb.id
    update('mixer', (m) => ({
      ...m,
      strips: m.strips.map((s) => {
        let n = s
        if (s.id === early) n = { ...n, delayMs: Math.min(500, Math.round((n.delayMs + Math.abs(o.ms)) * 100) / 100) }
        if (s.id === sb.id && o.inverted) n = { ...n, phaseInvert: !n.phaseInvert }
        return n
      })
    }))
  }

  const corr = stats?.corr ?? 0
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Fase y correlación</h2>
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'pair') setSrc({ mode: 'pair', a: cfg.strips[0]?.id ?? '', b: cfg.strips[1]?.id ?? cfg.strips[0]?.id ?? '' })
            else {
              const [kind, id] = v.split('|') as ['strip' | 'bus', string]
              setSrc({ mode: 'stereo', kind, id })
            }
          }}
        >
          {cfg.buses.map((b) => (
            <option key={b.id} value={`bus|${b.id}`}>
              Bus {b.label} · {b.name} (L/R)
            </option>
          ))}
          {stereoStrips.map((s) => (
            <option key={s.id} value={`strip|${s.id}`}>
              {s.name} (estéreo)
            </option>
          ))}
          {cfg.strips.length >= 2 && <option value="pair">Dos micrófonos (A vs B)</option>}
        </select>
      </header>
      {!on ? (
        <p className="st-muted">Enciende el mezclador: esta medida compara canales del mezclador (L/R de un bus, o dos entradas).</p>
      ) : (
        <>
          {src.mode === 'pair' && (
            <div className="st-row">
              {(['a', 'b'] as const).map((k) => (
                <label key={k} className="st-inline">
                  {k.toUpperCase()}
                  <select value={src[k]} onChange={(e) => setSrc(k === 'a' ? { ...src, a: e.target.value } : { ...src, b: e.target.value })}>
                    {cfg.strips.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <span className="st-muted st-small">Pon los dos micros frente a la misma fuente (voz o ruido rosa).</span>
            </div>
          )}
          <div className="st-phase">
            <div className="st-gonio-wrap">
              <canvas ref={canvas} className="st-gonio" />
              <button className="st-png" onClick={() => void saveCanvasPng(canvas.current, 'goniometro')} title="Guardar el goniómetro (PNG)">
                PNG
              </button>
            </div>
            <div className="st-phase-side">
              <div className="st-corr" title="Correlación de fase: +1 = idénticos, 0 = sin relación, −1 = fase invertida">
                <div className="st-corr-track">
                  <i style={{ left: `${((corr + 1) / 2) * 100}%` }} className={corr < 0 ? 'bad' : corr < 0.3 ? 'warn' : 'ok'} />
                </div>
                <div className="st-corr-scale">
                  <span>−1</span>
                  <span>0</span>
                  <span>+1</span>
                </div>
              </div>
              <div className="st-readouts">
                <Readout label="Correlación" value={stats ? corr.toFixed(2) : '—'} unit="" big tone={!stats ? '' : corr < 0 ? 'bad' : corr < 0.3 ? 'warn' : 'ok'} />
                <Readout label={src.mode === 'pair' ? 'Balance B−A' : 'Balance R−L'} value={stats ? stats.balance.toFixed(1) : '—'} unit="dB" />
                {src.mode === 'pair' && (
                  <>
                    <Readout label="Desfase" value={stats?.offset ? stats.offset.ms.toFixed(2) : '—'} unit="ms" />
                    <Readout label="Diferencia" value={stats?.offset ? String(offsetToCm(stats.offset.ms)) : '—'} unit="cm" />
                    <Readout label="Polaridad" value={stats?.offset ? (stats.offset.inverted ? 'Invertida' : 'Igual') : '—'} unit="" tone={stats?.offset?.inverted ? 'bad' : stats?.offset ? 'ok' : ''} />
                  </>
                )}
              </div>
              {stats && <p className="st-small">{correlationVerdict(corr)}</p>}
              {src.mode === 'pair' && stats?.offset && Math.abs(stats.offset.correlation) > 0.3 && (Math.abs(stats.offset.ms) >= 0.05 || stats.offset.inverted) && (
                <button className="st-btn primary" onClick={align} title="Retrasa el micro que llega antes y corrige la polaridad si hace falta">
                  Alinear {sa?.name} y {sb?.name}
                </button>
              )}
              {src.mode === 'pair' && stats?.offset && Math.abs(stats.offset.correlation) <= 0.3 && (
                <p className="st-muted st-small">Señales poco parecidas (similitud {Math.abs(stats.offset.correlation).toFixed(2)}): el desfase no es fiable.</p>
              )}
            </div>
          </div>
          <p className="st-muted st-small">
            Goniómetro: vertical = mono (todo en fase), horizontal = fase invertida, nube redonda = estéreo ancho. Mide antes del fader de cada entrada; los buses, después
            de su fader.
          </p>
        </>
      )}
    </section>
  )
}

// ---- Room acoustics (RT60)

type RoomMethod = 'noise' | 'clap'

function RoomPanel(): JSX.Element {
  const engine = useEngineState()
  const [method, setMethod] = useState<RoomMethod>('noise')
  const [level, setLevel] = useState(-10)
  const [phase, setPhase] = useState<'idle' | 'noise' | 'decay' | 'clap'>('idle')
  const [result, setResult] = useState<Rt60Result | null>(null)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    setResult(null)
    setError('')
    const chunks: Float32Array[] = []
    let sr = audioEngine.sampleRate
    const off = audioEngine.onPcm((c, _f, rate) => {
      chunks.push(c)
      sr = rate
    })
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    let start = 0
    try {
      if (method === 'noise') {
        setPhase('noise')
        generator.start({ kind: 'pink', freqHz: 1000, levelDb: level, sweepSeconds: 10 })
        await wait(2500)
        // Where the noise stops: a little earlier, so the decay's first moment is included
        start = Math.max(0, chunks.reduce((n, c) => n + c.length, 0) - Math.round(sr * 0.06))
        generator.stop(0.002)
        setPhase('decay')
        await wait(2500)
      } else {
        setPhase('clap')
        await wait(3500)
      }
    } finally {
      off()
      generator.stop()
      setPhase('idle')
    }
    const pcm = joinChunks(chunks)
    const res = measureRt60(pcm.subarray(start), sr)
    if (res.t20 === null) setError(res.dynamicRangeDb < 20 ? `Solo ${res.dynamicRangeDb} dB sobre el ruido: sube el volumen o aplaude más fuerte.` : 'No se detectó una caída clara. Repite la medida.')
    setResult(res)
  }

  const busy = phase !== 'idle'
  const rt = result?.t30 ?? result?.t20 ?? null
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Acústica de la sala (RT60)</h2>
        <div className="st-row">
          <Segmented<RoomMethod>
            value={method}
            onChange={setMethod}
            options={[
              ['noise', 'Ruido interrumpido'],
              ['clap', 'Aplauso']
            ]}
          />
          <button className="st-btn primary" disabled={busy || engine.status !== 'running'} onClick={() => void run()}>
            {phase === 'noise' ? 'Ruido rosa…' : phase === 'decay' ? 'Escuchando la cola…' : phase === 'clap' ? '👏 ¡Aplaude ahora!' : 'Medir'}
          </button>
        </div>
      </header>
      {method === 'noise' && (
        <div className="st-row">
          <label className="st-inline">
            Volumen del ruido
            <input type="range" min={-40} max={-3} value={level} onChange={(e) => setLevel(Number(e.target.value))} />
            <code>{level} dBFS</code>
          </label>
          <span className="st-muted st-small">Suena por la salida elegida arriba (🔊) durante 2,5 s y se corta de golpe.</span>
        </div>
      )}
      {result && rt !== null && (
        <div className="st-room">
          <div className="st-readouts">
            <Readout label="RT60 (T30)" value={result.t30 !== null ? result.t30.toFixed(2) : '—'} unit="s" big />
            <Readout label="T20" value={result.t20 !== null ? result.t20.toFixed(2) : '—'} unit="s" />
            <Readout label="EDT" value={result.edt !== null ? result.edt.toFixed(2) : '—'} unit="s" />
            <Readout label="Rango útil" value={String(result.dynamicRangeDb)} unit="dB" tone={result.dynamicRangeDb >= 45 ? 'ok' : 'warn'} />
          </div>
          <DecayCurve r={result} />
          <p className="st-small">{rt60Verdict(rt)}</p>
        </div>
      )}
      {error && <p className="st-error">{error}</p>}
      <p className="st-muted st-small">
        RT60 = tiempo que tarda el sonido en caer 60 dB. T30 necesita 45 dB de rango sobre el ruido; si no llega, se usa T20. Mide en silencio y con el micro en el centro de la
        sala, lejos del altavoz.
      </p>
    </section>
  )
}

function DecayCurve({ r }: { r: Rt60Result }): JSX.Element {
  const W = 560
  const H = 160
  const dur = (r.curve.length * r.stepMs) / 1000
  const x = (i: number): number => (i / Math.max(1, r.curve.length - 1)) * W
  const y = (db: number): number => (Math.min(0, Math.max(-60, db)) / -60) * H
  const path = r.curve.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d).toFixed(1)}`).join(' ')
  return (
    <svg className="st-decay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[-5, -25, -35].map((d) => (
        <g key={d}>
          <line x1={0} x2={W} y1={y(d)} y2={y(d)} className="mark" />
          <text x={W - 4} y={y(d) - 3} textAnchor="end">
            {d} dB
          </text>
        </g>
      ))}
      <path d={path} className="curve" />
      <text x={4} y={H - 4}>
        0 s
      </text>
      <text x={W - 4} y={H - 4} textAnchor="end">
        {dur.toFixed(2)} s
      </text>
    </svg>
  )
}
