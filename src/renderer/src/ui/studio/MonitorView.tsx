import { useEffect, useState } from 'react'
import { activeProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noiseFloorFrom } from '../../core/audio/Calibration'
import { MIN_DB } from '../../core/audio/LevelAnalyzer'
import { dominantFrequency, noteName } from '../../core/studio/analysis'
import { noteInfo } from '../../core/studio/pitch'
import type { SpectrumMode, StudioPrefs } from '../../core/studio/studio'
import { useEngineState, useKey, useReading } from '../hooks'
import { useStore } from '../store'
import { useLoudness, usePitch } from './meters'
import { ScopeCanvas, SpectrumView } from './spectrum'
import { BarMeter, fmtDb, fmtTime, MeterScale, Readout, Segmented, useInterval } from './widgets'

export function useStudioPrefs(): [StudioPrefs, (patch: Partial<StudioPrefs>) => void] {
  const { data, update } = useStore()
  return [data.studio.prefs, (patch) => update('studio', (s) => ({ ...s, prefs: { ...s.prefs, ...patch } }))]
}

export function MonitorView(): JSX.Element {
  const { data, update } = useStore()
  const [prefs, setPrefs] = useStudioPrefs()
  const profile = activeProfile(data.audio)
  const engine = useEngineState()
  const r = useReading()
  const [hold, setHold] = useState({ rms: MIN_DB, peak: MIN_DB, max: MIN_DB })
  const [clips, setClips] = useState(0)
  const [measuring, setMeasuring] = useState(false)
  const [reference, setReference] = useState<Float32Array | null>(null)
  const [dominant, setDominant] = useState<{ hz: number; db: number } | null>(null)
  const [paused, setPaused] = useState(false)

  useEffect(() => audioEngine.setSpectrumSmoothing(prefs.spectrumSmoothing), [prefs.spectrumSmoothing])

  // Dominant frequency a few times per second: enough to read, cheap to compute
  useInterval(() => {
    const s = audioEngine.spectrumDb()
    setDominant(s ? dominantFrequency(s.data, s.sampleRate, s.fftSize) : null)
  }, 250)

  const freezeReference = (): void => {
    const s = audioEngine.spectrumDb()
    if (s) setReference(new Float32Array(s.data))
  }
  useKey('KeyF', freezeReference, engine.status === 'running')
  useKey('KeyP', () => setPaused((p) => !p))

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
  const snr = rms - profile.noiseFloorDb
  const crest = r && r.rmsDb > MIN_DB ? r.peakDb - r.rmsDb : 0

  return (
    <div className="st-monitor">
      <div className="st-col">
        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Nivel de entrada</h2>
            <span className="st-device">{engine.status === 'running' ? engine.label : engine.error ?? 'Sin entrada'}</span>
          </header>
          <BarMeter label="RMS" db={rms} hold={hold.rms} />
          <BarMeter label="PEAK" db={r?.peakDb ?? MIN_DB} hold={hold.peak} />
          <MeterScale marks={[-60, -48, -36, -24, -18, -12, -6, -3, 0]} />
          <div className="st-readouts">
            <Readout label="RMS" value={fmtDb(rms)} unit="dBFS" />
            <Readout label="Pico" value={fmtDb(r?.peakDb ?? MIN_DB)} unit="dBFS" />
            <Readout label="Pico máx." value={fmtDb(hold.max)} unit="dBFS" onReset={() => setHold((h) => ({ ...h, max: MIN_DB }))} tone={hold.max > -1 ? 'bad' : hold.max > -6 ? 'warn' : ''} />
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
          <MonitorControls />
        </section>
        <LoudnessPanel target={prefs.loudnessTarget} onTarget={(v) => setPrefs({ loudnessTarget: v })} />
        <TunerPanel a4={prefs.tunerA4} onA4={(v) => setPrefs({ tunerA4: v })} />
      </div>

      <div className="st-col">
        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Analizador de espectro</h2>
            <Segmented<SpectrumMode>
              value={prefs.spectrumMode}
              onChange={(v) => setPrefs({ spectrumMode: v })}
              options={[
                ['fft', 'FFT'],
                ['rta', 'RTA 1/3 oct.'],
                ['spectrogram', 'Espectrograma'],
                ['waterfall', 'Cascada 3D']
              ]}
            />
          </header>
          <SpectrumView mode={prefs.spectrumMode} floorDb={prefs.spectrumFloorDb} reference={reference} paused={paused} />
          <div className="st-row">
            <span className="st-readout-inline">
              Dominante:{' '}
              <b>{dominant && dominant.db > profile.noiseFloorDb - 20 ? `${dominant.hz} Hz · ${noteName(dominant.hz)} · ${dominant.db.toFixed(0)} dB` : '—'}</b>
            </span>
            <span className="st-grow" />
            <label className="st-inline" title="Promediado del analizador">
              Suavizado
              <input type="range" min={0} max={0.95} step={0.05} value={prefs.spectrumSmoothing} onChange={(e) => setPrefs({ spectrumSmoothing: Number(e.target.value) })} />
            </label>
            <label className="st-inline">
              Rango
              <select value={prefs.spectrumFloorDb} onChange={(e) => setPrefs({ spectrumFloorDb: Number(e.target.value) })}>
                {[-60, -80, -100, -120].map((v) => (
                  <option key={v} value={v}>
                    {v} dB
                  </option>
                ))}
              </select>
            </label>
            <button className="st-btn" onClick={() => setPaused((p) => !p)} title="P">
              {paused ? '▶ Seguir' : '❚❚ Congelar'}
            </button>
            {prefs.spectrumMode === 'fft' && (
              <>
                <button className="st-btn" onClick={freezeReference} disabled={engine.status !== 'running'} title="Guarda el espectro actual para comparar posiciones o micrófonos (F)">
                  {reference ? 'Actualizar referencia' : 'Fijar referencia'}
                </button>
                {reference && (
                  <button className="st-btn ghost" onClick={() => setReference(null)}>
                    Quitar referencia
                  </button>
                )}
              </>
            )}
          </div>
          <p className="st-muted st-small">
            {prefs.spectrumMode === 'fft' && 'FFT 8192 · naranja = retención de picos · pasa el ratón para leer frecuencia y nivel. Si hay acople, la frecuencia dominante dice qué banda recortar.'}
            {prefs.spectrumMode === 'rta' && 'Analizador en tercios de octava (energía por banda). Con ruido rosa del generador, una sala/altavoz neutro se ve plano.'}
            {prefs.spectrumMode === 'spectrogram' && 'Espectrograma: tiempo de derecha a izquierda, frecuencia en vertical, color = nivel. Útil para ver sibilancias, zumbidos y acoples.'}
            {prefs.spectrumMode === 'waterfall' && 'Cascada (waterfall): los últimos 2 s de espectros apilados, el más reciente delante. Un pico que se mantiene en todas las líneas es un acople o un zumbido.'}
          </p>
        </section>

        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Osciloscopio</h2>
            <span className="st-muted st-small">Disparo en cruce por cero</span>
          </header>
          <ScopeCanvas />
        </section>
      </div>
    </div>
  )
}

/** Direct monitoring through headphones, with a feedback warning */
function MonitorControls(): JSX.Element {
  const [prefs, setPrefs] = useStudioPrefs()
  const on = prefs.monitorDb !== null
  return (
    <div className="st-row st-monitor-out">
      <label className="st-inline">
        <input type="checkbox" checked={on} onChange={(e) => setPrefs({ monitorDb: e.target.checked ? -12 : null })} />
        Escuchar entrada (auriculares)
      </label>
      {on && (
        <>
          <input type="range" min={-40} max={6} step={1} value={prefs.monitorDb ?? -12} onChange={(e) => setPrefs({ monitorDb: Number(e.target.value) })} />
          <span className="st-mono">{prefs.monitorDb} dB</span>
          <span className="st-small warn">Usa auriculares: con altavoces se acopla.</span>
        </>
      )}
    </div>
  )
}

const LUFS_PRESETS: [number, string][] = [
  [-14, 'Streaming −14'],
  [-16, 'Podcast −16'],
  [-23, 'EBU R128 −23'],
  [-24, 'ATSC −24']
]

function LoudnessPanel({ target, onTarget }: { target: number; onTarget: (v: number) => void }): JSX.Element {
  const { reading: l, reset } = useLoudness()
  const v = (x: number | undefined): string => (x === undefined || x <= -70 ? '—' : x.toFixed(1))
  const diff = l && l.integrated > -70 ? l.integrated - target : null
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Sonoridad (EBU R128)</h2>
        <div className="st-row">
          <select value={target} onChange={(e) => onTarget(Number(e.target.value))} title="Objetivo de sonoridad integrada">
            {LUFS_PRESETS.map(([t, label]) => (
              <option key={t} value={t}>
                {label} LUFS
              </option>
            ))}
          </select>
          <button className="st-btn" onClick={reset}>
            ↺ Reiniciar
          </button>
        </div>
      </header>
      <BarMeter label="M" db={l?.momentary ?? -100} hold={l?.maxMomentary ?? -100} min={-50} max={0} />
      <BarMeter label="S" db={l?.shortTerm ?? -100} hold={target} min={-50} max={0} />
      <MeterScale marks={[-50, -40, -30, -23, -14, -6, 0]} min={-50} max={0} unit="LUFS" />
      <div className="st-readouts">
        <Readout label="Momentánea (400 ms)" value={v(l?.momentary)} unit="LUFS" />
        <Readout label="Corto plazo (3 s)" value={v(l?.shortTerm)} unit="LUFS" />
        <Readout
          label="Integrada"
          value={v(l?.integrated)}
          unit="LUFS"
          big
          tone={diff === null ? '' : Math.abs(diff) <= 1 ? 'ok' : Math.abs(diff) <= 3 ? 'warn' : 'bad'}
        />
        <Readout label="Rango (LRA)" value={l ? l.lra.toFixed(1) : '—'} unit="LU" />
        <Readout label="True peak máx." value={l ? fmtDb(l.truePeakDb) : '—'} unit="dBTP" tone={l && l.truePeakDb > -1 ? 'bad' : ''} />
        <Readout label="Tiempo" value={l ? fmtTime(l.durationS) : '—'} unit="" />
      </div>
      <p className="st-muted st-small">
        {diff === null ? 'Habla o reproduce para medir.' : diff > 0 ? `${diff.toFixed(1)} LU por encima del objetivo.` : `${(-diff).toFixed(1)} LU por debajo del objetivo.`} La línea
        blanca de «S» marca el objetivo.
      </p>
    </section>
  )
}

function TunerPanel({ a4, onA4 }: { a4: number; onA4: (v: number) => void }): JSX.Element {
  const pitch = usePitch()
  const [last, setLast] = useState<{ hz: number; at: number } | null>(null)
  useEffect(() => {
    if (pitch && pitch.clarity > 0.85) setLast({ hz: pitch.hz, at: performance.now() })
  }, [pitch])
  // Keep the last note visible briefly so it doesn't flicker between syllables
  const shown = last && performance.now() - last.at < 1200 ? last.hz : null
  const n = shown ? noteInfo(shown, a4) : null
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Afinador / tono de voz</h2>
        <label className="st-inline">
          La4 =
          <input type="number" min={415} max={466} value={a4} onChange={(e) => onA4(Math.min(466, Math.max(415, Number(e.target.value) || 440)))} />
          Hz
        </label>
      </header>
      <div className="st-tuner">
        <div className="st-tuner-note">{n ? n.solfege : '—'}</div>
        <div className="st-tuner-scale">
          <div className="st-tuner-center" />
          {n && <div className={`st-tuner-needle ${Math.abs(n.cents) <= 5 ? 'ok' : ''}`} style={{ left: `${50 + n.cents}%` }} />}
          <span style={{ left: '0%' }}>−50</span>
          <span style={{ left: '50%' }}>0</span>
          <span style={{ left: '100%' }}>+50</span>
        </div>
        <div className="st-tuner-hz">
          {shown ? `${shown.toFixed(1)} Hz` : 'Canta o toca una nota'}
          {n && ` · ${n.name} · ${n.cents > 0 ? '+' : ''}${n.cents} cents`}
        </div>
      </div>
    </section>
  )
}
