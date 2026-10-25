import { useEffect, useRef, useState } from 'react'
import { mixerEngine, multitrackTracks, type MultitrackSpec } from '../../core/audio/MixerEngine'
import type { MixerConfig, MultitrackPrefs } from '../../core/mixer/mixer'
import type { WavFormat } from '../../core/studio/analysis'
import { bytesPerSecond, fmtTimecode, pcmBytes, sessionFolderName, trackFileNames, type MultitrackSession } from '../../core/studio/multitrack'
import { api } from '../storage'
import { useStore } from '../store'
import { fmtTime, Segmented, usePolled } from './widgets'

// Multitrack recording of the mixer: one WAV per strip (and per chosen bus), all starting on
// the same sample, streamed to disk while recording.

type Phase = 'idle' | 'starting' | 'rec' | 'stopping'

interface Take {
  id: number
  folder: string
  format: WavFormat
  sampleRate: number
  startedAt: Date
  files: string[]
  tracks: { name: string; channels: number; source: string }[]
  markers: { timeS: number; label: string }[]
  bytes: number
}

const fmtBytes = (b: number): string => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`)

// The take lives outside the component: switching tabs mid-take must not lose it
let active: Take | null = null
const resultListeners = new Set<(r: { message: string; folder: string | null }) => void>()

/** Ends the active take: last chunks, header sizes, session files. Safe to call twice */
async function closeTake(interrupted: boolean): Promise<void> {
  const t = active
  const a = api()
  if (!t || !a) return
  active = null
  if (!interrupted) await mixerEngine.stopMultitrack()
  const durationS = t.bytes / Math.max(1, bytesPerSecond(t.tracks, t.format, t.sampleRate))
  const session: MultitrackSession = {
    app: 'gritometro-multipista',
    version: 1,
    startedAt: t.startedAt.toISOString(),
    sampleRate: t.sampleRate,
    format: t.format,
    durationS: Math.round(durationS * 1000) / 1000,
    tracks: t.tracks.map((x, i) => ({ ...x, file: t.files[i] })),
    markers: t.markers
  }
  const text = [
    `Grabación multipista · ${t.startedAt.toLocaleString()}`,
    `${t.sampleRate} Hz · ${t.format === 'float' ? '32 bits float' : `${t.format} bits`} · ${fmtTimecode(durationS)}`,
    '',
    'Pistas:',
    ...t.tracks.map((x, i) => `  ${t.files[i]}  <-  ${x.source}${x.channels === 2 ? ' (estéreo)' : ''}`),
    ...(t.markers.length ? ['', 'Marcadores:', ...t.markers.map((m) => `  ${fmtTimecode(m.timeS)}  ${m.label}`)] : [])
  ].join('\r\n')
  const res = await a.rec.close(t.id, [
    { name: 'sesion.json', content: JSON.stringify(session, null, 2) },
    { name: 'sesion.txt', content: text }
  ])
  if (!res) return
  const head = interrupted ? 'El mezclador se reconstruyó y la toma se cerró. ' : ''
  const message = res.errors.length ? `${head}Guardado con errores: ${res.errors[0]}` : `${head}${t.tracks.length} pistas guardadas (${fmtBytes(res.bytes)}) en ${res.folder}`
  resultListeners.forEach((l) => l({ message, folder: res.folder }))
}

export function MultitrackPanel({ cfg, setCfg, on }: { cfg: MixerConfig; setCfg: (fn: (m: MixerConfig) => MixerConfig) => void; on: boolean }): JSX.Element {
  const { data, update } = useStore()
  const format = data.studio.wavFormat
  const prefs = cfg.multitrack
  const [phase, setPhase] = useState<Phase>(active ? 'rec' : 'idle')
  const [msg, setMsg] = useState('')
  const [lastFolder, setLastFolder] = useState<string | null>(null)
  useEffect(() => {
    const l = (r: { message: string; folder: string | null }): void => {
      setPhase('idle')
      setMsg(r.message)
      setLastFolder(r.folder)
    }
    resultListeners.add(l)
    return () => {
      resultListeners.delete(l)
    }
  }, [])
  const seconds = usePolled(() => mixerEngine.multitrackSeconds(), 200)
  const [, force] = useState(0)

  const setPrefs = (p: Partial<MultitrackPrefs>): void => setCfg((m) => ({ ...m, multitrack: { ...m.multitrack, ...p } }))
  const stripIds = prefs.strips ?? cfg.strips.map((s) => s.id)
  const spec: MultitrackSpec = { point: prefs.point, strips: cfg.strips.filter((s) => stripIds.includes(s.id)).map((s) => s.id), buses: prefs.buses.filter((b) => cfg.buses.some((x) => x.id === b)) }
  const planned = multitrackTracks(cfg, spec)
  const rate = bytesPerSecond(planned, format, cfg.sampleRate ?? 48000)
  const recording = phase === 'rec'

  const toggleStrip = (id: string, v: boolean): void => {
    const set = new Set(stripIds)
    if (v) set.add(id)
    else set.delete(id)
    setPrefs({ strips: cfg.strips.map((s) => s.id).filter((x) => set.has(x)) })
  }
  const toggleBus = (id: string, v: boolean): void => setPrefs({ buses: v ? [...prefs.buses, id] : prefs.buses.filter((b) => b !== id) })

  const chooseDir = async (): Promise<string | null> => {
    const dir = await api()?.rec.chooseDir(prefs.dir)
    if (dir) setPrefs({ dir })
    return dir ?? null
  }

  const finish = async (): Promise<void> => {
    setPhase('stopping')
    await closeTake(false)
    setPhase('idle')
  }

  const start = async (): Promise<void> => {
    const a = api()
    if (!a) return setMsg('La grabación multipista necesita la aplicación de escritorio.')
    if (!on) return setMsg('Enciende el mezclador primero.')
    if (!planned.length) return setMsg('Elige al menos una pista.')
    setPhase('starting')
    setMsg('')
    try {
      const dir = prefs.dir ?? (await chooseDir())
      if (!dir) return setPhase('idle')
      const sampleRate = mixerEngine.state.sampleRate ?? 48000
      const startedAt = new Date()
      const files = trackFileNames(planned.map((t) => t.name))
      const opened = await a.rec.open(dir, sessionFolderName(startedAt), files.map((file, i) => ({ file, channels: planned[i].channels })), sampleRate, format)
      const t: Take = { id: opened.id, folder: opened.folder, format, sampleRate, startedAt, files, tracks: planned, markers: [], bytes: 0 }
      active = t
      const tracks = mixerEngine.startMultitrack(
        cfg,
        spec,
        (i, channels) => {
          const bytes = pcmBytes(channels, format)
          t.bytes += bytes.length
          void a.rec.write(t.id, i, bytes)
        },
        () => void closeTake(true)
      )
      if (!tracks) {
        active = null
        await a.rec.close(t.id)
        setPhase('idle')
        return setMsg('No se pudo empezar: alguna entrada elegida no está abierta en el mezclador.')
      }
      setPhase('rec')
    } catch (err) {
      active = null
      setPhase('idle')
      setMsg(`No se pudo crear la carpeta de la toma: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const marker = (): void => {
    const t = active
    if (!t) return
    const timeS = mixerEngine.multitrackSeconds()
    t.markers.push({ timeS, label: `Marcador ${t.markers.length + 1}` })
    force((n) => n + 1)
  }

  // M = marker while recording (the mixer tab only)
  const markerRef = useRef(marker)
  markerRef.current = marker
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || e.ctrlKey || e.altKey) return
      if ((e.key === 'm' || e.key === 'M') && active) markerRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section className={`st-panel st-multitrack ${recording ? 'recording' : ''}`}>
      <header className="st-panel-head">
        <h2>Grabación multipista</h2>
        <div className="st-row">
          {recording && (
            <>
              <span className="st-mt-rec">REC</span>
              <b className="st-mono st-mt-time">{fmtTime(seconds)}</b>
              <span className="st-muted st-small st-mono">{fmtBytes(active?.bytes ?? 0)}</span>
              <button className="st-btn" onClick={marker} title="Añadir un marcador (M)">
                Marcador
              </button>
            </>
          )}
          <button
            className={`st-btn rec ${recording ? 'on' : ''}`}
            disabled={phase === 'starting' || phase === 'stopping' || (!recording && (!on || planned.length === 0))}
            onClick={() => (recording ? void finish() : void start())}
          >
            {phase === 'starting' ? 'Preparando…' : phase === 'stopping' ? 'Guardando…' : recording ? 'Detener' : 'Grabar multipista'}
          </button>
        </div>
      </header>

      <div className="st-row">
        <Segmented<MultitrackPrefs['point']>
          value={prefs.point}
          onChange={(point) => !recording && setPrefs({ point })}
          options={[
            ['input', 'Entrada (sin procesar)'],
            ['pre', 'Procesada (pre-fader)'],
            ['post', 'Post-fader']
          ]}
          title="Qué se graba de cada entrada: la señal tal como llega (tras el trim), con su procesamiento, o tras el fader y el panorama"
        />
        <label className="st-inline">
          Formato
          <select
            value={String(format)}
            disabled={recording}
            onChange={(e) => update('studio', (s) => ({ ...s, wavFormat: (e.target.value === 'float' ? 'float' : Number(e.target.value)) as WavFormat }))}
          >
            <option value="16">WAV 16 bits</option>
            <option value="24">WAV 24 bits</option>
            <option value="float">WAV 32 bits float</option>
          </select>
        </label>
        <span className="st-grow" />
        <span className="st-muted st-small" title={prefs.dir ?? ''}>
          {prefs.dir ? `Carpeta: ${prefs.dir}` : 'Se pedirá la carpeta al grabar'}
        </span>
        <button className="st-btn ghost" disabled={recording} onClick={() => void chooseDir()}>
          Cambiar carpeta…
        </button>
      </div>

      <div className="st-mt-tracks">
        {cfg.strips.map((s) => (
          <label key={s.id} className={`st-mt-track ${stripIds.includes(s.id) ? 'on' : ''}`} style={{ ['--strip' as string]: s.color }}>
            <input type="checkbox" checked={stripIds.includes(s.id)} disabled={recording} onChange={(e) => toggleStrip(s.id, e.target.checked)} />
            <span>{s.name}</span>
            <small>{prefs.point === 'post' || s.input.mode === 'stereo' ? 'estéreo' : 'mono'}</small>
          </label>
        ))}
        <span className="st-mt-sep" />
        {cfg.buses.map((b) => (
          <label key={b.id} className={`st-mt-track bus ${prefs.buses.includes(b.id) ? 'on' : ''}`}>
            <input type="checkbox" checked={prefs.buses.includes(b.id)} disabled={recording} onChange={(e) => toggleBus(b.id, e.target.checked)} />
            <span>
              Bus {b.label} · {b.name}
            </span>
            <small>estéreo</small>
          </label>
        ))}
      </div>

      <p className="st-muted st-small">
        <b>{`${planned.length} pistas · ≈ ${fmtBytes(rate * 60)} por minuto.`}</b>{' '}
        <span>
          Cada pista es un WAV en una carpeta nueva por toma, todas alineadas al mismo sample, con sesion.txt y sesion.json (pistas y marcadores). Se escribe en disco mientras grabas.
        </span>{' '}
        <span>No añadas ni quites entradas durante la toma: el mezclador se reconstruye y la toma se cierra.</span>
      </p>
      {recording && active && active.markers.length > 0 && (
        <p className="st-small st-mono">
          {active.markers.map((m) => `${fmtTimecode(m.timeS)} ${m.label}`).join(' · ')}
        </p>
      )}
      {msg && (
        <p className="st-small">
          {msg}{' '}
          {lastFolder && (
            <button className="st-btn ghost" onClick={() => void api()?.file.openPath(lastFolder)}>
              Abrir carpeta
            </button>
          )}
        </p>
      )}
    </section>
  )
}
