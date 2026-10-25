import { useEffect, useMemo, useState } from 'react'
import { activeProfile, effectiveProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noiseFloorFrom } from '../../core/audio/Calibration'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import { newId, shuffle } from '../../core/players/players'
import { BAND_CENTERS, encodeWav, matchGain, pcmRms, summarizeTake, technicalScore } from '../../core/studio/analysis'
import type { MicCandidate } from '../../core/studio/studio'
import { saveFile } from '../storage'
import { useStore } from '../store'
import { onPlaybackChange, playTake, stopPlayback, takeStore } from './playback'

const COLORS = ['#ffb020', '#3fb6ff', '#5ee08a', '#ff6b8b', '#b48cff', '#ffe066', '#4dd6c9', '#ff9a5a']

type Phase = { id: string; step: 'switching' | 'silence' | 'countdown' | 'take' | 'analyzing'; remaining: number } | null

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function CompareView(): JSX.Element {
  const { data, update } = useStore()
  const studio = data.studio
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [form, setForm] = useState({ name: '', deviceId: '', channel: 'mix' as 'mix' | number, gainDb: 0 })
  const [phase, setPhase] = useState<Phase>(null)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [blind, setBlind] = useState<{ order: string[]; ratings: Record<string, number>; revealed: boolean } | null>(null)
  const [, force] = useState(0)

  useEffect(() => {
    listInputs().then(setDevices).catch(() => setDevices([]))
    return onPlaybackChange(setPlaying)
  }, [])
  useEffect(() => () => stopPlayback(), [])

  const setCandidates = (fn: (c: MicCandidate[]) => MicCandidate[]): void =>
    update('studio', (s) => ({ ...s, candidates: fn(s.candidates) }))

  const add = (): void => {
    const dev = devices.find((d) => d.deviceId === form.deviceId)
    const name = form.name.trim() || dev?.label || `Micrófono ${studio.candidates.length + 1}`
    setCandidates((cs) => [...cs, { id: newId('mic'), name, deviceId: form.deviceId || null, channel: form.channel, gainDb: form.gainDb }])
    setForm({ name: '', deviceId: '', channel: 'mix', gainDb: 0 })
  }

  const recordTake = async (c: MicCandidate): Promise<void> => {
    setError('')
    stopPlayback()
    const base = activeProfile(data.audio)
    try {
      setPhase({ id: c.id, step: 'switching', remaining: 0 })
      await audioEngine.start({ ...base, deviceId: c.deviceId, channel: c.channel, gainDb: c.gainDb, disableProcessing: true, ballistics: 'fast', gateDb: -120 })
      if (audioEngine.state.status !== 'running') throw new Error(audioEngine.state.error ?? 'No se pudo abrir el micrófono.')
      await wait(700)

      setPhase({ id: c.id, step: 'silence', remaining: studio.silenceSeconds })
      const quiet = await audioEngine.record(studio.silenceSeconds * 1000)
      const floor = noiseFloorFrom(quiet, 0.5)

      for (let i = 3; i > 0; i--) {
        setPhase({ id: c.id, step: 'countdown', remaining: i })
        await wait(1000)
      }
      setPhase({ id: c.id, step: 'take', remaining: studio.takeSeconds })
      const started = performance.now()
      const timer = setInterval(
        () => setPhase((p) => (p ? { ...p, remaining: Math.max(0, studio.takeSeconds - (performance.now() - started) / 1000) } : p)),
        200
      )
      const take = await audioEngine.captureTake(studio.takeSeconds * 1000, floor + 10)
      clearInterval(timer)

      setPhase({ id: c.id, step: 'analyzing', remaining: 0 })
      const metrics = summarizeTake({ frames: take.frames, noiseFloorDb: floor, power: take.power, sampleRate: take.sampleRate, fftSize: take.fftSize })
      takeStore.set(c.id, { pcm: take.pcm, sampleRate: take.sampleRate, rms: pcmRms(take.pcm) })
      setCandidates((cs) => cs.map((x) => (x.id === c.id ? { ...x, metrics, takenAt: new Date().toISOString() } : x)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPhase(null)
      // Back to the configured input
      audioEngine.start(effectiveProfile(data.audio))
    }
  }

  const withTakes = studio.candidates.filter((c) => takeStore.has(c.id))
  const targetRms = Math.min(...withTakes.map((c) => takeStore.get(c.id)!.rms).filter((v) => v > 0))

  const play = (id: string): void => {
    if (playing === id) return stopPlayback()
    const t = takeStore.get(id)
    if (!t) return
    playTake(id, t, studio.matchLoudness && Number.isFinite(targetRms) ? matchGain(t.rms, targetRms) : 1)
  }

  const exportWav = async (c: MicCandidate): Promise<void> => {
    const t = takeStore.get(c.id)
    if (t) await saveFile(`${c.name}.wav`, toBase64(encodeWav(t.pcm, t.sampleRate)), 'base64')
  }

  const exportCsv = (): void => {
    const head = ['Micrófono', 'Ruido dBFS', 'Nivel dBFS', 'Pico dBFS', 'SNR dB', 'Cresta dB', 'Clips', 'Centroide Hz', 'Graves %', 'Medios %', 'Agudos %', 'Puntuación', 'Nota a ciegas']
    const rows = studio.candidates
      .filter((c) => c.metrics)
      .map((c) => {
        const m = c.metrics!
        return [c.name, m.noiseFloorDb, m.levelDb, m.peakDb, m.snrDb, m.crestDb, m.clipCount, m.centroidHz, Math.round(m.bands.low * 100), Math.round(m.bands.mid * 100), Math.round(m.bands.high * 100), technicalScore(m).total, c.rating ?? '']
      })
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n')
    saveFile('comparacion-microfonos.csv', '﻿' + csv)
  }

  const startBlind = (): void => {
    stopPlayback()
    setBlind({ order: shuffle(withTakes.map((c) => c.id)), ratings: {}, revealed: false })
  }

  const reveal = (): void => {
    if (!blind) return
    setCandidates((cs) => cs.map((c) => (blind.ratings[c.id] ? { ...c, rating: blind.ratings[c.id] } : c)))
    setBlind({ ...blind, revealed: true })
  }

  const measured = studio.candidates.filter((c) => c.metrics)
  const bestTech = useMemo(
    () => [...measured].sort((a, b) => technicalScore(b.metrics!).total - technicalScore(a.metrics!).total)[0],
    [measured]
  )
  const favorite = [...measured].filter((c) => c.rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0]
  const busy = phase !== null

  return (
    <div className="st-compare">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Micrófonos a comparar</h2>
          <div className="st-row">
            <label className="st-inline">
              Toma
              <input type="number" min={3} max={30} value={studio.takeSeconds} onChange={(e) => update('studio', (s) => ({ ...s, takeSeconds: Math.min(30, Math.max(3, Number(e.target.value))) }))} />s
            </label>
            <label className="st-inline">
              Silencio
              <input type="number" min={1} max={10} value={studio.silenceSeconds} onChange={(e) => update('studio', (s) => ({ ...s, silenceSeconds: Math.min(10, Math.max(1, Number(e.target.value))) }))} />s
            </label>
            <label className="st-inline">
              <input type="checkbox" checked={studio.matchLoudness} onChange={(e) => update('studio', (s) => ({ ...s, matchLoudness: e.target.checked }))} />
              Igualar volumen al escuchar
            </label>
          </div>
        </header>

        <div className="st-row st-add">
          <select value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
            <option value="">Predeterminado de Windows</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
                {d.virtual ? ' [virtual]' : ''}
              </option>
            ))}
          </select>
          <select value={form.channel === 'mix' ? 'mix' : String(form.channel)} onChange={(e) => setForm({ ...form, channel: e.target.value === 'mix' ? 'mix' : Number(e.target.value) })}>
            <option value="mix">Mezcla</option>
            {Array.from({ length: 8 }, (_, i) => (
              <option key={i} value={i}>
                Canal {i + 1}
              </option>
            ))}
          </select>
          <label className="st-inline">
            Trim
            <input type="number" min={-24} max={24} value={form.gainDb} onChange={(e) => setForm({ ...form, gainDb: Number(e.target.value) })} />
            dB
          </label>
          <input className="st-grow" placeholder="Nombre (p. ej. SM58 a 10 cm)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <button className="st-btn primary" onClick={add}>
            + Añadir
          </button>
        </div>
        <p className="st-muted">
          Procedimiento: para cada micrófono se mide el ruido en silencio y luego se graba una toma. Usa la misma frase, distancia y volumen en todas las tomas.
        </p>
        {error && <p className="st-error">{error}</p>}

        {studio.candidates.length > 0 && (
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th />
                  <th>Micrófono</th>
                  <th>Ruido</th>
                  <th>Nivel</th>
                  <th>Pico</th>
                  <th>SNR</th>
                  <th>Cresta</th>
                  <th>Brillo</th>
                  <th>Graves · Medios · Agudos</th>
                  <th>Clips</th>
                  <th>Puntuación</th>
                  <th>Nota</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {studio.candidates.map((c, i) => {
                  const m = c.metrics
                  const score = m ? technicalScore(m) : null
                  const recording = phase?.id === c.id
                  return (
                    <tr key={c.id} className={bestTech?.id === c.id ? 'best' : ''}>
                      <td>
                        <span className="st-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                      </td>
                      <td>
                        <input className="st-name" value={c.name} onChange={(e) => setCandidates((cs) => cs.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} />
                        <div className="st-muted st-small">
                          {devices.find((d) => d.deviceId === c.deviceId)?.label ?? (c.deviceId ? 'Dispositivo no conectado' : 'Predeterminado')} ·{' '}
                          {c.channel === 'mix' ? 'mezcla' : `canal ${c.channel + 1}`} · trim {c.gainDb} dB
                        </div>
                      </td>
                      <td>{m ? m.noiseFloorDb.toFixed(1) : '—'}</td>
                      <td>{m ? m.levelDb.toFixed(1) : '—'}</td>
                      <td>{m ? m.peakDb.toFixed(1) : '—'}</td>
                      <td className={m ? (m.snrDb > 40 ? 'ok' : m.snrDb > 25 ? 'warn' : 'bad') : ''}>{m ? `${m.snrDb.toFixed(1)} dB` : '—'}</td>
                      <td>{m ? m.crestDb.toFixed(1) : '—'}</td>
                      <td>{m ? `${(m.centroidHz / 1000).toFixed(2)} kHz` : '—'}</td>
                      <td>
                        {m ? (
                          <div className="st-bands" title={`${Math.round(m.bands.low * 100)}% · ${Math.round(m.bands.mid * 100)}% · ${Math.round(m.bands.high * 100)}%`}>
                            <span style={{ flex: m.bands.low }} className="low" />
                            <span style={{ flex: m.bands.mid }} className="mid" />
                            <span style={{ flex: m.bands.high }} className="high" />
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={m?.clipCount ? 'bad' : ''}>{m ? m.clipCount : '—'}</td>
                      <td title={score?.notes.join('\n')}>
                        {score ? (
                          <>
                            <b className="st-score">{score.total}</b>
                            {score.notes.length > 0 && <div className="st-muted st-small">{score.notes[0]}</div>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{c.rating ? '★'.repeat(c.rating) : '—'}</td>
                      <td className="st-actions">
                        {recording ? (
                          <span className="st-rec">
                            {phase.step === 'switching' && 'Abriendo…'}
                            {phase.step === 'silence' && '🤫 Silencio…'}
                            {phase.step === 'countdown' && `Prepárate ${phase.remaining}`}
                            {phase.step === 'take' && `● REC ${phase.remaining.toFixed(1)} s`}
                            {phase.step === 'analyzing' && 'Analizando…'}
                          </span>
                        ) : (
                          <>
                            <button className="st-btn rec" disabled={busy} onClick={() => recordTake(c)}>
                              ● {m ? 'Repetir' : 'Grabar'}
                            </button>
                            <button className="st-btn" disabled={busy || !takeStore.has(c.id)} onClick={() => play(c.id)}>
                              {playing === c.id ? '■' : '▶'}
                            </button>
                            <button className="st-btn" disabled={!takeStore.has(c.id)} onClick={() => exportWav(c)} title="Exportar WAV">
                              WAV
                            </button>
                            <button
                              className="st-btn ghost"
                              disabled={busy}
                              onClick={() => {
                                takeStore.delete(c.id)
                                setCandidates((cs) => cs.filter((x) => x.id !== c.id))
                                force((n) => n + 1)
                              }}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {measured.length > 0 && (
          <div className="st-row st-summary">
            {bestTech && (
              <span>
                Mejor técnicamente: <b>{bestTech.name}</b>
              </span>
            )}
            {favorite && (
              <span>
                Favorito a ciegas: <b>{favorite.name}</b>
              </span>
            )}
            <span className="st-grow" />
            <button className="st-btn" onClick={exportCsv}>
              Exportar CSV
            </button>
            <button className="st-btn primary" disabled={withTakes.length < 2 || busy} onClick={startBlind}>
              Prueba a ciegas (A/B)
            </button>
          </div>
        )}
        {measured.length > 0 && withTakes.length < measured.length && (
          <p className="st-muted st-small">Las grabaciones de audio solo se guardan durante la sesión; las mediciones sí quedan guardadas.</p>
        )}
      </section>

      {blind && (
        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Prueba a ciegas</h2>
            <span className="st-muted">Orden aleatorio{studio.matchLoudness ? ', volumen igualado' : ''}. Escucha y califica sin saber cuál es cuál.</span>
          </header>
          <div className="st-blind">
            {blind.order.map((id, i) => {
              const c = studio.candidates.find((x) => x.id === id)
              return (
                <div key={id} className="st-blind-item">
                  <b>Muestra {String.fromCharCode(65 + i)}</b>
                  <button className="st-btn" onClick={() => play(id)}>
                    {playing === id ? '■ Detener' : '▶ Escuchar'}
                  </button>
                  <div className="st-stars">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        className={(blind.ratings[id] ?? 0) >= n ? 'on' : ''}
                        disabled={blind.revealed}
                        onClick={() => setBlind((b) => (b ? { ...b, ratings: { ...b.ratings, [id]: n } } : b))}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                  {blind.revealed && <span className="st-reveal">= {c?.name}</span>}
                </div>
              )
            })}
          </div>
          <div className="st-row">
            {!blind.revealed ? (
              <button className="st-btn primary" disabled={Object.keys(blind.ratings).length < blind.order.length} onClick={reveal}>
                Revelar resultados
              </button>
            ) : (
              <button className="st-btn" onClick={startBlind}>
                Repetir prueba
              </button>
            )}
            <button className="st-btn ghost" onClick={() => setBlind(null)}>
              Cerrar
            </button>
          </div>
        </section>
      )}

      {measured.length > 0 && (
        <section className="st-panel">
          <header className="st-panel-head">
            <h2>Respuesta en frecuencia (tercios de octava, normalizada)</h2>
            <span className="st-muted">Compara la forma: curva más alta en una zona = ese micro realza esas frecuencias</span>
          </header>
          <ResponseChart candidates={studio.candidates} />
        </section>
      )}
    </div>
  )
}

function ResponseChart({ candidates }: { candidates: MicCandidate[] }): JSX.Element {
  const W = 900
  const H = 260
  const PAD = { l: 40, r: 12, t: 10, b: 26 }
  const MIN = -30
  const MAX = 15
  const x = (i: number): number => PAD.l + (i / (BAND_CENTERS.length - 1)) * (W - PAD.l - PAD.r)
  const y = (db: number): number => PAD.t + ((MAX - Math.max(MIN, Math.min(MAX, db))) / (MAX - MIN)) * (H - PAD.t - PAD.b)
  const ticks = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]
  return (
    <div>
      <svg className="st-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[-30, -20, -10, 0, 10].map((d) => (
          <g key={d}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(d)} y2={y(d)} className={d === 0 ? 'zero' : 'grid'} />
            <text x={PAD.l - 6} y={y(d) + 4} textAnchor="end">
              {d}
            </text>
          </g>
        ))}
        {ticks.map((f) => {
          const i = BAND_CENTERS.indexOf(f === 16000 ? 16000 : f)
          if (i < 0) return null
          return (
            <g key={f}>
              <line x1={x(i)} x2={x(i)} y1={PAD.t} y2={H - PAD.b} className="grid" />
              <text x={x(i)} y={H - 8} textAnchor="middle">
                {f >= 1000 ? `${f / 1000}k` : f}
              </text>
            </g>
          )
        })}
        {candidates.map((c, ci) =>
          c.metrics ? (
            <polyline
              key={c.id}
              fill="none"
              stroke={COLORS[ci % COLORS.length]}
              strokeWidth="2.5"
              strokeLinejoin="round"
              points={c.metrics.curve.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            />
          ) : null
        )}
      </svg>
      <div className="st-legend">
        {candidates.map((c, ci) =>
          c.metrics ? (
            <span key={c.id}>
              <i style={{ background: COLORS[ci % COLORS.length] }} />
              {c.name}
            </span>
          ) : null
        )}
      </div>
    </div>
  )
}
