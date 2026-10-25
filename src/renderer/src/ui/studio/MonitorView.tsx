import { useEffect, useRef, useState } from 'react'
import { activeProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noiseFloorFrom } from '../../core/audio/Calibration'
import { MIN_DB } from '../../core/audio/LevelAnalyzer'
import { dominantFrequency, noteName } from '../../core/studio/analysis'
import { useEngineState, useReading } from '../hooks'
import { useStore } from '../store'

const METER_MIN = -60

function pct(db: number): number {
  return Math.min(100, Math.max(0, ((db - METER_MIN) / -METER_MIN) * 100))
}

/** Segmented horizontal meter with peak hold, studio style */
function BarMeter({ label, db, hold }: { label: string; db: number; hold: number }): JSX.Element {
  return (
    <div className="st-meter">
      <span className="st-meter-label">{label}</span>
      <div className="st-meter-track">
        <div className="st-meter-fill" style={{ clipPath: `inset(0 ${100 - pct(db)}% 0 0)` }} />
        <div className="st-meter-hold" style={{ left: `${pct(hold)}%` }} />
      </div>
      <span className="st-meter-value">{db < MIN_DB + 1 ? '-∞' : db.toFixed(1)}</span>
    </div>
  )
}

function MeterScale(): JSX.Element {
  return (
    <div className="st-meter st-scale">
      <span className="st-meter-label" />
      <div className="st-meter-track st-scale-track">
        {[-60, -48, -36, -24, -18, -12, -6, -3, 0].map((d) => (
          <span key={d} style={{ left: `${pct(d)}%` }}>
            {d}
          </span>
        ))}
      </div>
      <span className="st-meter-value">dBFS</span>
    </div>
  )
}

const FREQ_LABELS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const fx = (f: number, w: number): number => (Math.log10(f / 20) / Math.log10(1000)) * w

/** Resizes the backing store only when the element size changes (resizing every frame reallocates it) */
function fitCanvas(c: HTMLCanvasElement): [number, number] {
  const w = Math.round(c.clientWidth * devicePixelRatio)
  const h = Math.round(c.clientHeight * devicePixelRatio)
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  return [w, h]
}

/** Log-frequency analyzer with decaying peak line and an optional frozen reference curve */
export function SpectrumCanvas({ height = 260, reference = null }: { height?: number; reference?: Float32Array | null }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const refCurve = useRef(reference)
  refCurve.current = reference
  useEffect(() => {
    let raf = 0
    let peaks: Float32Array | null = null
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      g.clearRect(0, 0, w, h)
      // grid
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.fillStyle = css.getPropertyValue('--st-muted')
      g.font = `${11 * devicePixelRatio}px Consolas, monospace`
      g.lineWidth = 1
      for (const f of FREQ_LABELS) {
        const x = fx(f, w)
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, h)
        g.stroke()
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 4)
      }
      for (let db = -100; db <= 0; db += 20) {
        const y = (-db / 100) * h
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(w, y)
        g.stroke()
        g.fillText(`${db}`, 3, y + 12)
      }
      const s = audioEngine.spectrumDb()
      if (!s) return
      if (!peaks || peaks.length !== s.data.length) peaks = new Float32Array(s.data.length).fill(-120)
      const yOf = (db: number): number => Math.min(h, Math.max(0, (-db / 100) * h))
      const ref = refCurve.current
      if (ref && ref.length === s.data.length) {
        g.beginPath()
        let rx = -1
        for (let i = 1; i < ref.length; i++) {
          const f = (i * s.sampleRate) / s.fftSize
          if (f < 20 || f > 20000) continue
          const x = fx(f, w)
          if (x - rx < 2) continue
          rx = x
          g.lineTo(x, yOf(ref[i]))
        }
        g.strokeStyle = css.getPropertyValue('--st-ref') || '#b48cff'
        g.lineWidth = 1.5 * devicePixelRatio
        g.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio])
        g.stroke()
        g.setLineDash([])
        g.lineWidth = 1
      }
      g.beginPath()
      g.moveTo(0, h)
      let lastX = -1
      for (let i = 1; i < s.data.length; i++) {
        const f = (i * s.sampleRate) / s.fftSize
        if (f < 20 || f > 20000) continue
        const db = s.data[i]
        peaks[i] = Math.max(db, peaks[i] - 0.4)
        const x = fx(f, w)
        if (x - lastX < 1) continue
        lastX = x
        g.lineTo(x, yOf(db))
      }
      g.lineTo(w, h)
      g.closePath()
      const grad = g.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, css.getPropertyValue('--st-accent'))
      grad.addColorStop(1, 'transparent')
      g.fillStyle = grad
      g.globalAlpha = 0.55
      g.fill()
      g.globalAlpha = 1
      g.strokeStyle = css.getPropertyValue('--st-accent')
      g.stroke()
      // peak hold line
      g.beginPath()
      lastX = -1
      for (let i = 1; i < peaks.length; i++) {
        const f = (i * s.sampleRate) / s.fftSize
        if (f < 20 || f > 20000) continue
        const x = fx(f, w)
        if (x - lastX < 2) continue
        lastX = x
        g.lineTo(x, yOf(peaks[i]))
      }
      g.strokeStyle = css.getPropertyValue('--st-warn')
      g.globalAlpha = 0.7
      g.stroke()
      g.globalAlpha = 1
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="st-canvas" style={{ height }} />
}

function ScopeCanvas(): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const data = audioEngine.waveform()
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      g.clearRect(0, 0, w, h)
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, h / 2)
      g.lineTo(w, h / 2)
      g.stroke()
      if (!data) return
      g.strokeStyle = css.getPropertyValue('--st-ok')
      g.lineWidth = 1.5 * devicePixelRatio
      g.beginPath()
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * w
        const y = h / 2 - data[i] * (h / 2)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="st-canvas" style={{ height: 120 }} />
}

export function MonitorView(): JSX.Element {
  const { data, update } = useStore()
  const profile = activeProfile(data.audio)
  const engine = useEngineState()
  const r = useReading()
  const [hold, setHold] = useState({ rms: MIN_DB, peak: MIN_DB, max: MIN_DB })
  const [clips, setClips] = useState(0)
  const [measuring, setMeasuring] = useState(false)
  const [reference, setReference] = useState<Float32Array | null>(null)
  const [dominant, setDominant] = useState<{ hz: number; db: number } | null>(null)

  // Dominant frequency a few times per second: enough to read, cheap to compute
  useEffect(() => {
    const t = setInterval(() => {
      const s = audioEngine.spectrumDb()
      setDominant(s ? dominantFrequency(s.data, s.sampleRate, s.fftSize) : null)
    }, 250)
    return () => clearInterval(t)
  }, [])

  const freezeReference = (): void => {
    const s = audioEngine.spectrumDb()
    if (s) setReference(new Float32Array(s.data))
  }

  useEffect(() => {
    if (!r) return
    setHold((h) => ({
      rms: Math.max(r.smoothedDb, h.rms - 0.3),
      peak: Math.max(r.peakDb, h.peak - 0.3),
      max: Math.max(r.peakDb, h.max)
    }))
    if (r.clipped) setClips((c) => c + 1)
  }, [r])

  const measureNoise = async (): Promise<void> => {
    setMeasuring(true)
    const frames = await audioEngine.record(3000)
    const floor = noiseFloorFrom(frames)
    update('audio', (a) => ({ ...a, profiles: a.profiles.map((p) => (p.id === a.activeProfileId ? { ...p, noiseFloorDb: floor } : p)) }))
    setMeasuring(false)
  }

  // The smoothed level only approaches the floor asymptotically: snap it to silence
  const rawRms = r?.smoothedDb ?? MIN_DB
  const rms = rawRms < MIN_DB + 1 ? MIN_DB : rawRms
  const fmt = (v: number): string => (v <= MIN_DB ? '-∞' : v.toFixed(1))
  const snr = rms - profile.noiseFloorDb
  const crest = r && r.rmsDb > MIN_DB ? r.peakDb - r.rmsDb : 0

  return (
    <div className="st-monitor">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Nivel de entrada</h2>
          <span className="st-device">{engine.status === 'running' ? engine.label : engine.error ?? 'Sin entrada'}</span>
        </header>
        <BarMeter label="RMS" db={rms} hold={hold.rms} />
        <BarMeter label="PEAK" db={r?.peakDb ?? MIN_DB} hold={hold.peak} />
        <MeterScale />
        <div className="st-readouts">
          <Readout label="RMS" value={fmt(rms)} unit="dBFS" />
          <Readout label="Pico" value={fmt(r?.peakDb ?? MIN_DB)} unit="dBFS" />
          <Readout label="Pico máx." value={fmt(hold.max)} unit="dBFS" onReset={() => setHold((h) => ({ ...h, max: MIN_DB }))} />
          <Readout label="Factor de cresta" value={crest.toFixed(1)} unit="dB" />
          <Readout label="Ruido de fondo" value={profile.noiseFloorDb.toFixed(1)} unit="dBFS" />
          <Readout label="SNR en vivo" value={rms <= MIN_DB ? '—' : snr.toFixed(1)} unit="dB" tone={snr > 40 ? 'ok' : snr > 25 ? 'warn' : 'bad'} />
          <Readout label="SPL aprox." value={rms <= MIN_DB ? '—' : String(Math.round(rms + profile.splOffset))} unit="dB" />
          <Readout label="Clips" value={String(clips)} unit="" tone={clips ? 'bad' : 'ok'} onReset={() => setClips(0)} />
          <Readout label="Muestreo" value={engine.sampleRate ? String(engine.sampleRate / 1000) : '—'} unit="kHz" />
          <Readout label="Canales" value={String(engine.channelCount ?? '—')} unit="" />
        </div>
        <div className="st-row">
          <button className="st-btn" onClick={measureNoise} disabled={measuring || engine.status !== 'running'}>
            {measuring ? 'Midiendo… silencio' : 'Medir ruido de fondo (3 s)'}
          </button>
          <span className="st-muted">Perfil: {profile.name}</span>
        </div>
      </section>

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Analizador de espectro</h2>
          <span className="st-muted">FFT 8192 · naranja = retención de picos{reference ? ' · morado = referencia' : ''}</span>
        </header>
        <SpectrumCanvas reference={reference} />
        <div className="st-row">
          <span className="st-readout-inline">
            Frecuencia dominante:{' '}
            <b>{dominant && dominant.db > profile.noiseFloorDb - 20 ? `${dominant.hz} Hz · ${noteName(dominant.hz)} · ${dominant.db.toFixed(0)} dB` : '—'}</b>
          </span>
          <span className="st-grow" />
          <button className="st-btn" onClick={freezeReference} disabled={engine.status !== 'running'} title="Guarda el espectro actual para comparar posiciones o micrófonos">
            {reference ? 'Actualizar referencia' : 'Fijar referencia'}
          </button>
          {reference && (
            <button className="st-btn ghost" onClick={() => setReference(null)}>
              Quitar referencia
            </button>
          )}
        </div>
        <p className="st-muted st-small">
          Si hay acople (pitido), la frecuencia dominante te dice qué banda recortar en el ecualizador. La referencia sirve para comparar posiciones del micrófono en vivo.
        </p>
      </section>

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Osciloscopio</h2>
        </header>
        <ScopeCanvas />
      </section>
    </div>
  )
}

function Readout({
  label,
  value,
  unit,
  tone,
  onReset
}: {
  label: string
  value: string
  unit: string
  tone?: 'ok' | 'warn' | 'bad'
  onReset?: () => void
}): JSX.Element {
  return (
    <div className={`st-readout ${tone ?? ''}`}>
      <small>
        {label}
        {onReset && (
          <button className="st-reset" onClick={onReset} title="Reiniciar">
            ↺
          </button>
        )}
      </small>
      <b>
        {value} <i>{unit}</i>
      </b>
    </div>
  )
}
