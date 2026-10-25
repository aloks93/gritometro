import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { audioEngine, joinChunks } from '../../core/audio/AudioEngine'
import { MIN_DB } from '../../core/audio/LevelAnalyzer'
import { decodeWav, encodeWav, envelope, pcmRms, pcmStats, type WavFormat } from '../../core/studio/analysis'
import { LoudnessMeter, measureLoudness, type LoudnessReading } from '../../core/studio/loudness'
import { newId } from '../../core/players/players'
import { useEngineState, useKey, useReading } from '../hooks'
import { openBinaryFiles, saveFile, toBase64 } from '../storage'
import { useStore } from '../store'
import { onPlaybackChange, playbackPosition, playTake, stopPlayback } from './playback'
import { BarMeter, fitCanvas, fmtDb, fmtTime } from './widgets'

const MAX_SECONDS = 15 * 60

export interface Recording {
  id: string
  name: string
  pcm: Float32Array
  sampleRate: number
  createdAt: string
  markers: number[]
  loudness: LoudnessReading
  peakDb: number
  rmsDb: number
  dcOffset: number
  clippedSamples: number
  envelope: number[]
  imported?: boolean
}

// Session-only recordings (raw audio is never persisted)
let recordings: Recording[] = []
const subs = new Set<() => void>()
const setRecordings = (fn: (r: Recording[]) => Recording[]): void => {
  recordings = fn(recordings)
  subs.forEach((s) => s())
}
const useRecordings = (): Recording[] =>
  useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => recordings
  )

function analyze(pcm: Float32Array, sampleRate: number, loudness?: LoudnessReading): Omit<Recording, 'id' | 'name' | 'createdAt' | 'markers'> {
  const stats = pcmStats(pcm)
  const rms = pcmRms(pcm)
  return {
    pcm,
    sampleRate,
    loudness: loudness ?? measureLoudness(pcm, sampleRate),
    peakDb: stats.peakDb,
    rmsDb: rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB,
    dcOffset: stats.dcOffset,
    clippedSamples: stats.clippedSamples,
    envelope: envelope(pcm, 600)
  }
}

/** Gain (dB) that reaches `targetLufs` without pushing the true peak over `ceilingDb` */
export function normalizeGainDb(r: { loudness: LoudnessReading }, targetLufs: number, ceilingDb = -1): number {
  if (r.loudness.integrated <= -70) return 0
  return Math.min(targetLufs - r.loudness.integrated, ceilingDb - r.loudness.truePeakDb)
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'grabacion'
}

export function RecorderView(): JSX.Element {
  const { data, update } = useStore()
  const engine = useEngineState()
  const reading = useReading()
  const list = useRecordings()
  const format = data.studio.wavFormat
  const target = data.studio.prefs.loudnessTarget
  const [rec, setRec] = useState<{ started: number; elapsed: number; markers: number[]; live: LoudnessReading | null } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const session = useRef<{ chunks: Float32Array[]; meter: LoudnessMeter | null; env: number[]; markers: number[]; started: number; off: () => void; sampleRate: number } | null>(null)
  const liveCanvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => onPlaybackChange(setPlaying), [])
  // Leaving the tab finishes an ongoing recording instead of losing it
  useEffect(() => () => void (session.current && finish()), [])

  const start = (): void => {
    if (session.current || engine.status !== 'running') return
    stopPlayback()
    setMsg('')
    const started = performance.now()
    const s = { chunks: [] as Float32Array[], meter: null as LoudnessMeter | null, env: [] as number[], markers: [] as number[], started, off: (() => undefined) as () => void, sampleRate: audioEngine.sampleRate }
    s.off = audioEngine.onPcm((chunk, _f, sr) => {
      if (!s.meter) {
        s.meter = new LoudnessMeter(sr)
        s.sampleRate = sr
      }
      s.chunks.push(chunk)
      s.meter.push(chunk)
      let m = 0
      for (let i = 0; i < chunk.length; i++) m = Math.max(m, Math.abs(chunk[i]))
      s.env.push(m)
    })
    session.current = s
    setRec({ started, elapsed: 0, markers: [], live: null })
  }

  const finish = (): void => {
    const s = session.current
    if (!s) return
    session.current = null
    s.off()
    const pcm = joinChunks(s.chunks)
    if (pcm.length > 0) {
      const n = recordings.filter((x) => !x.imported).length + 1
      const item: Recording = {
        id: newId('rec'),
        name: `Grabación ${n}`,
        createdAt: new Date().toISOString(),
        markers: s.markers,
        ...analyze(pcm, s.sampleRate, s.meter?.reading())
      }
      setRecordings((all) => [item, ...all])
    }
    setRec(null)
  }

  const addMarker = (): void => {
    const s = session.current
    if (!s) return
    s.markers.push((performance.now() - s.started) / 1000)
    setRec((r) => (r ? { ...r, markers: [...s.markers] } : r))
  }

  // Elapsed time, live loudness and the auto-stop
  useEffect(() => {
    if (!rec) return
    const t = setInterval(() => {
      const elapsed = (performance.now() - rec.started) / 1000
      setRec((r) => (r ? { ...r, elapsed, live: session.current?.meter?.reading() ?? null } : r))
      if (elapsed >= MAX_SECONDS) finish()
    }, 100)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.started])

  // Growing waveform while recording
  useEffect(() => {
    if (!rec) return
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = liveCanvas.current
      const env = session.current?.env
      if (!c || !env) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const css = getComputedStyle(c)
      // Last ~20 s, newest at the right
      const visible = Math.round((20 * (session.current?.sampleRate ?? 48000)) / 2048)
      const from = Math.max(0, env.length - visible)
      const bw = w / visible
      for (let i = from; i < env.length; i++) {
        const v = env[i]
        const bh = Math.max(1, v * h)
        g.fillStyle = v >= 0.99 ? css.getPropertyValue('--st-bad') : css.getPropertyValue('--st-ok')
        g.fillRect((i - from) * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [rec?.started])

  useKey('KeyR', () => (session.current ? finish() : start()), engine.status === 'running' || !!session.current)
  useKey('KeyM', addMarker, !!rec)

  const importWav = async (): Promise<void> => {
    const files = await openBinaryFiles(['wav'])
    const bad: string[] = []
    for (const f of files) {
      const decoded = decodeWav(f.data)
      if (!decoded || decoded.pcm.length === 0) {
        bad.push(f.name)
        continue
      }
      setMsg(`Analizando ${f.name}…`)
      // Yield so the message paints before the (blocking) loudness analysis
      await new Promise((r) => setTimeout(r, 30))
      const item: Recording = { id: newId('rec'), name: f.name.replace(/\.wav$/i, ''), createdAt: new Date().toISOString(), markers: [], imported: true, ...analyze(decoded.pcm, decoded.sampleRate) }
      setRecordings((all) => [item, ...all])
    }
    setMsg(bad.length ? `No se pudieron leer: ${bad.join(', ')} (solo WAV PCM 8/16/24/32 bits o float)` : '')
  }

  const exportWav = async (r: Recording, normalized: boolean): Promise<void> => {
    let pcm = r.pcm
    let suffix = ''
    if (normalized) {
      const db = normalizeGainDb(r, target)
      const g = Math.pow(10, db / 20)
      pcm = new Float32Array(r.pcm.length)
      for (let i = 0; i < pcm.length; i++) pcm[i] = r.pcm[i] * g
      suffix = ` (${target} LUFS)`
    }
    const path = await saveFile(`${safeFileName(r.name)}${suffix}.wav`, toBase64(encodeWav(pcm, r.sampleRate, format)), 'base64')
    if (path) setMsg(`Guardado en ${path}`)
  }

  const live = rec?.live
  return (
    <div className="st-recorder">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Grabadora</h2>
          <div className="st-row">
            <label className="st-inline">
              Formato WAV
              <select value={String(format)} onChange={(e) => update('studio', (s) => ({ ...s, wavFormat: (e.target.value === 'float' ? 'float' : Number(e.target.value)) as WavFormat }))}>
                <option value="16">16 bits</option>
                <option value="24">24 bits</option>
                <option value="float">32 bits float</option>
              </select>
            </label>
            <button className="st-btn" onClick={importWav} disabled={!!rec}>
              Importar WAV…
            </button>
          </div>
        </header>
        <div className="st-row st-rec-bar">
          {rec ? (
            <>
              <button className="st-btn rec on" onClick={finish} title="R">
                ■ Detener
              </button>
              <span className="st-rec-time">● {fmtTime(rec.elapsed)}</span>
              <button className="st-btn" onClick={addMarker} title="M">
                + Marcador ({rec.markers.length})
              </button>
            </>
          ) : (
            <button className="st-btn rec" disabled={engine.status !== 'running'} onClick={start} title="R">
              ● Grabar
            </button>
          )}
          <div className="st-grow">
            <BarMeter label="PEAK" db={reading?.peakDb ?? MIN_DB} hold={reading?.peakDb ?? MIN_DB} />
          </div>
        </div>
        {rec && (
          <>
            <canvas ref={liveCanvas} className="st-canvas" style={{ height: 90 }} />
            <div className="st-muted st-small st-mono">
              M {fmtDb(live?.momentary ?? -100)} · S {fmtDb(live?.shortTerm ?? -100)} · I {fmtDb(live?.integrated ?? -100)} LUFS · TP {fmtDb(live?.truePeakDb ?? -100)} dBTP · máx.{' '}
              {MAX_SECONDS / 60} min
            </div>
          </>
        )}
        <p className="st-muted st-small">
          Atajos: <b>R</b> grabar/detener · <b>M</b> marcador. Graba la señal tras el trim del perfil, sin procesamiento de Windows si el perfil lo desactiva. El audio solo vive
          mientras la app está abierta: expórtalo.
        </p>
        {msg && <p className="st-small">{msg}</p>}
      </section>

      {list.length > 0 && (
        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Tomas de la sesión ({list.length})</h2>
            <span className="st-muted st-small">Normalizar = llevar a {target} LUFS sin pasar de −1 dBTP (objetivo del Monitor)</span>
          </header>
          {list.map((r) => (
            <RecordingRow key={r.id} r={r} playing={playing === r.id} onExport={(n) => exportWav(r, n)} target={target} />
          ))}
        </section>
      )}
    </div>
  )
}

function RecordingRow({ r, playing, onExport, target }: { r: Recording; playing: boolean; onExport: (normalized: boolean) => void; target: number }): JSX.Element {
  const duration = r.pcm.length / r.sampleRate
  const [loop, setLoop] = useState(false)
  const play = (offset = 0): void => {
    if (playing && offset === 0) return stopPlayback()
    playTake(r.id, { pcm: r.pcm, sampleRate: r.sampleRate, rms: 0 }, 1, { offset, loop })
  }
  const gain = normalizeGainDb(r, target)
  const l = r.loudness
  return (
    <div className="st-recording">
      <div className="st-row">
        <input className="st-name" value={r.name} onChange={(e) => setRecordings((all) => all.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
        <span className="st-muted st-small">
          {fmtTime(duration)} · {r.sampleRate / 1000} kHz{r.imported ? ' · importado' : ''}
        </span>
        <span className="st-grow" />
        <button className="st-btn" onClick={() => play()}>
          {playing ? '■' : '▶'}
        </button>
        <label className="st-inline st-small">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          Bucle
        </label>
        <button className="st-btn" onClick={() => onExport(false)}>
          WAV
        </button>
        <button className="st-btn" onClick={() => onExport(true)} title={`Ganancia ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`} disabled={l.integrated <= -70}>
          WAV normalizado
        </button>
        <button
          className="st-btn ghost"
          onClick={() => {
            if (playing) stopPlayback()
            setRecordings((all) => all.filter((x) => x.id !== r.id))
          }}
        >
          ✕
        </button>
      </div>
      <WaveformSeek r={r} duration={duration} onSeek={(s) => play(s)} />
      <div className="st-rec-metrics st-mono st-small">
        <span>
          Integrada <b>{fmtDb(l.integrated)}</b> LUFS
        </span>
        <span>
          LRA <b>{l.lra.toFixed(1)}</b> LU
        </span>
        <span>
          M máx. <b>{fmtDb(l.maxMomentary)}</b>
        </span>
        <span className={l.truePeakDb > -1 ? 'bad' : ''}>
          True peak <b>{fmtDb(l.truePeakDb)}</b> dBTP
        </span>
        <span>
          Pico <b>{fmtDb(r.peakDb)}</b> · RMS <b>{fmtDb(r.rmsDb)}</b> dBFS
        </span>
        {r.clippedSamples > 0 && <span className="bad">{r.clippedSamples} muestras saturadas</span>}
        {Math.abs(r.dcOffset) > 0.01 && <span className="warn">DC offset {r.dcOffset}</span>}
        {r.markers.length > 0 && <span>Marcadores: {r.markers.map((m) => fmtTime(m)).join(', ')}</span>}
      </div>
    </div>
  )
}

/** Waveform with markers and a playhead; click to play from that point */
function WaveformSeek({ r, duration, onSeek }: { r: Recording; duration: number; onSeek: (s: number) => void }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      g.clearRect(0, 0, w, h)
      const env = r.envelope
      const bw = w / env.length
      env.forEach((v, i) => {
        const bh = Math.max(1, v * h)
        g.fillStyle = v >= 0.99 ? css.getPropertyValue('--st-bad') : css.getPropertyValue('--st-accent')
        g.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.3), bh)
      })
      g.fillStyle = css.getPropertyValue('--st-ref')
      for (const m of r.markers) g.fillRect((m / duration) * w - 1, 0, 2 * devicePixelRatio, h)
      const pos = playbackPosition()
      if (pos?.id === r.id) {
        g.fillStyle = css.getPropertyValue('--st-text')
        g.fillRect((pos.seconds / duration) * w, 0, 2 * devicePixelRatio, h)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [r, duration])
  return (
    <canvas
      ref={canvas}
      className="st-canvas st-seek"
      style={{ height: 64 }}
      onClick={(e) => onSeek((e.nativeEvent.offsetX / e.currentTarget.clientWidth) * duration)}
      title="Clic para reproducir desde ahí"
    />
  )
}
