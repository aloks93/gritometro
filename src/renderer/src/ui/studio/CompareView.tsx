import { useEffect, useRef, useState } from 'react'
import { activeProfile, effectiveProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noiseFloorFrom } from '../../core/audio/Calibration'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import { newId, shuffle } from '../../core/players/players'
import { BAND_CENTERS, curveDifference, encodeWav, matchGain, pcmRms, smoothCurve, summarizeTake, technicalScore } from '../../core/studio/analysis'
import { noteInfo } from '../../core/studio/pitch'
import { buildReportHtml } from '../../core/studio/report'
import { mergeCandidates, parseSession, serializeSession, type MicCandidate } from '../../core/studio/studio'
import { useKey } from '../hooks'
import { openTextFile, saveFile, saveHtmlAsPdf, toBase64 } from '../storage'
import { useStore } from '../store'
import { isGroupPlaying, onPlaybackChange, playGroup, playTake, stopPlayback, switchGroup, takeStore } from './playback'

const COLORS = ['#ffb020', '#3fb6ff', '#5ee08a', '#ff6b8b', '#b48cff', '#ffe066', '#4dd6c9', '#ff9a5a']

type Phase = { id: string; step: 'switching' | 'silence' | 'countdown' | 'take' | 'analyzing'; remaining: number } | null

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Windows forbids these in file names */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'toma'
}

/** Spanish Excel reads ';'-separated CSV with decimal commas */
function csvNumber(v: number | string): string {
  return typeof v === 'number' ? String(v).replace('.', ',') : v
}

export function CompareView(): JSX.Element {
  const { data, update } = useStore()
  const studio = data.studio
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [form, setForm] = useState({ name: '', deviceId: '', channel: 'mix' as 'mix' | number, gainDb: 0 })
  const [phase, setPhase] = useState<Phase>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [playing, setPlaying] = useState<string | null>(null)
  const [blind, setBlind] = useState<{ order: string[]; ratings: Record<string, number>; revealed: boolean } | null>(null)
  const [, force] = useState(0)
  const cancelAll = useRef(false)
  const [recordingAll, setRecordingAll] = useState(false)

  useEffect(() => {
    listInputs().then(setDevices).catch(() => setDevices([]))
    return onPlaybackChange(setPlaying)
  }, [])
  useEffect(() => () => stopPlayback(), [])

  const setCandidates = (fn: (c: MicCandidate[]) => MicCandidate[]): void =>
    update('studio', (s) => ({ ...s, candidates: fn(s.candidates) }))
  const patch = (id: string, p: Partial<MicCandidate>): void => setCandidates((cs) => cs.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const add = (): void => {
    const dev = devices.find((d) => d.deviceId === form.deviceId)
    const name = form.name.trim() || dev?.label || `Micrófono ${studio.candidates.length + 1}`
    setCandidates((cs) => [...cs, { id: newId('mic'), name, deviceId: form.deviceId || null, channel: form.channel, gainDb: form.gainDb }])
    setForm({ name: '', deviceId: '', channel: 'mix', gainDb: 0 })
  }

  const move = (id: string, dir: -1 | 1): void =>
    setCandidates((cs) => {
      const i = cs.findIndex((c) => c.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= cs.length) return cs
      const next = [...cs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  /** Records one candidate; `restore` reopens the configured input afterwards */
  const recordTake = async (c: MicCandidate, restore = true): Promise<boolean> => {
    setError('')
    stopPlayback()
    const base = activeProfile(data.audio)
    try {
      setPhase({ id: c.id, step: 'switching', remaining: 0 })
      // Each candidate is its own device, even while a mixer bus is being analysed
      await audioEngine.start({ ...base, deviceId: c.deviceId, channel: c.channel, gainDb: c.gainDb, disableProcessing: true, ballistics: 'fast', gateDb: -120 }, { ignoreOverride: true })
      if (audioEngine.state.status !== 'running') throw new Error(audioEngine.state.error ?? 'No se pudo abrir el micrófono.')
      await wait(700)

      setPhase({ id: c.id, step: 'silence', remaining: studio.silenceSeconds })
      // Nothing counts as 'voiced' here, so the spectrum averages the whole silence
      const quiet = await audioEngine.captureTake(studio.silenceSeconds * 1000, Infinity)
      const floor = noiseFloorFrom(quiet.frames, 0.5)

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
      if (audioEngine.state.status !== 'running') throw new Error('Se perdió el micrófono durante la toma.')
      // Let "Analizando…" paint: loudness, true peak and pitch take a moment
      await wait(30)
      const metrics = summarizeTake({
        frames: take.frames,
        noiseFloorDb: floor,
        power: take.power,
        sampleRate: take.sampleRate,
        fftSize: take.fftSize,
        noisePower: quiet.power,
        pcm: take.pcm
      })
      takeStore.set(c.id, { pcm: take.pcm, sampleRate: take.sampleRate, rms: pcmRms(take.pcm) })
      patch(c.id, { metrics, takenAt: new Date().toISOString() })
      return true
    } catch (err) {
      setError(`${c.name}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      setPhase(null)
      // Back to the configured input
      if (restore) audioEngine.start(effectiveProfile(data.audio))
    }
  }

  /** One take per candidate in a row, so the operator only swaps/positions mics */
  const recordAll = async (): Promise<void> => {
    cancelAll.current = false
    setRecordingAll(true)
    for (const c of studio.candidates) {
      if (cancelAll.current) break
      if (!(await recordTake(c, false))) break
    }
    setRecordingAll(false)
    audioEngine.start(effectiveProfile(data.audio))
  }

  const withTakes = studio.candidates.filter((c) => takeStore.has(c.id))
  const targetRms = Math.min(...withTakes.map((c) => takeStore.get(c.id)!.rms).filter((v) => v > 0))
  const gainFor = (id: string): number => {
    const t = takeStore.get(id)
    return t && studio.matchLoudness && Number.isFinite(targetRms) ? matchGain(t.rms, targetRms) : 1
  }

  const play = (id: string): void => {
    // Inside a synced A/B group, switching is instant and keeps the position
    if (isGroupPlaying() && switchGroup(id)) return
    if (playing === id) return stopPlayback()
    const t = takeStore.get(id)
    if (!t) return
    playTake(id, t, gainFor(id))
  }

  const startSynced = (ids: string[], active = ids[0]): void => {
    const items = ids.flatMap((id) => {
      const take = takeStore.get(id)
      return take ? [{ id, take, gain: gainFor(id) }] : []
    })
    if (items.length >= 2) playGroup(items, active)
  }

  // Keyboard: 1–9 picks a take (or blind sample), Space stops
  const order = blind ? blind.order : withTakes.map((c) => c.id)
  const busy = phase !== null || recordingAll
  useKey('Space', stopPlayback, !busy && playing !== null)
  for (let n = 1; n <= 9; n++) {
    // Fixed number of hook calls: one per digit
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKey(`Digit${n}`, () => order[n - 1] && play(order[n - 1]), !busy && order.length >= n)
  }

  const exportWav = async (c: MicCandidate): Promise<void> => {
    const t = takeStore.get(c.id)
    if (t) await saveFile(`${safeFileName(c.name)}.wav`, toBase64(encodeWav(t.pcm, t.sampleRate, studio.wavFormat)), 'base64')
  }

  const exportCsv = (): void => {
    const head = ['Micrófono', 'Ruido dBFS', 'Ruido A dBFS', 'Nivel dBFS', 'LUFS', 'LRA LU', 'Pico dBFS', 'True peak dBTP', 'SNR dB', 'Cresta dB', 'Clips', 'Muestras saturadas', 'Centroide Hz', 'Graves %', 'Medios %', 'Agudos %', 'Tono Hz', 'Zumbido', 'DC offset', 'Puntuación', 'Notas técnicas', 'Nota a ciegas', 'Observaciones']
    const rows = studio.candidates
      .filter((c) => c.metrics)
      .map((c) => {
        const m = c.metrics!
        const s = technicalScore(m)
        const hum = m.hum ? `${m.hum.hz} Hz` : m.hum === null ? 'no' : ''
        return [c.name, m.noiseFloorDb, m.noiseADb ?? '', m.levelDb, m.lufs ?? '', m.lra ?? '', m.peakDb, m.truePeakDb ?? '', m.snrDb, m.crestDb, m.clipCount, m.clippedSamples ?? '', m.centroidHz, Math.round(m.bands.low * 100), Math.round(m.bands.mid * 100), Math.round(m.bands.high * 100), m.pitchHz ?? '', hum, m.dcOffset ?? '', s.total, s.notes.join(' / '), c.rating ?? '', c.notes ?? '']
      })
    const csv = [head, ...rows].map((r) => r.map((v) => `"${csvNumber(v).replace(/"/g, '""')}"`).join(';')).join('\r\n')
    saveFile('comparacion-microfonos.csv', '﻿' + csv)
  }

  const exportPdf = async (): Promise<void> => {
    const path = await saveHtmlAsPdf('comparacion-microfonos.pdf', buildReportHtml(studio.candidates))
    if (path) setInfo(`Informe guardado en ${path}`)
  }

  const saveSession = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10)
    const path = await saveFile(`sesion-estudio-${stamp}.json`, serializeSession(studio))
    if (path) setInfo(`Sesión guardada en ${path} (solo mediciones; exporta los WAV aparte).`)
  }

  const loadSession = async (): Promise<void> => {
    setError('')
    const text = await openTextFile(['json'])
    if (!text) return
    try {
      const s = parseSession(text)
      const replace = studio.candidates.length > 0 && confirm('¿Reemplazar la comparación actual? (Cancelar = añadir a la actual)')
      setCandidates((cs) => (replace || cs.length === 0 ? s.candidates : mergeCandidates(cs, s.candidates, () => newId('mic'))))
      setInfo(`Sesión cargada: ${s.candidates.length} micrófonos${s.exportedAt ? ` (${new Date(s.exportedAt).toLocaleString('es')})` : ''}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
  const bestTech = [...measured].sort((a, b) => technicalScore(b.metrics!).total - technicalScore(a.metrics!).total)[0]
  const favorite = [...measured].filter((c) => c.rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0]
  const groupOn = isGroupPlaying()

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
            <button className="st-btn ghost" onClick={loadSession} disabled={busy}>
              Abrir sesión…
            </button>
            <button className="st-btn ghost" onClick={saveSession} disabled={studio.candidates.length === 0}>
              Guardar sesión
            </button>
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
          <input className="st-grow" placeholder="Nombre (p. ej. SM58 a 10 cm)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="st-btn primary" onClick={add}>
            + Añadir
          </button>
        </div>
        <p className="st-muted st-small">
          Procedimiento: para cada micrófono se mide el ruido en silencio y luego se graba una toma. Usa la misma frase, distancia y volumen en todas las tomas. Teclas <b>1–9</b>{' '}
          escuchan cada toma, <b>Espacio</b> detiene.
        </p>
        {error && <p className="st-error">{error}</p>}
        {info && <p className="st-small">{info}</p>}
        {studio.candidates.length > 1 && (
          <div className="st-row">
            {recordingAll ? (
              <button className="st-btn ghost" onClick={() => (cancelAll.current = true)}>
                Detener tras esta toma
              </button>
            ) : (
              <button className="st-btn rec" disabled={busy} onClick={recordAll}>
                ● Grabar todos en orden
              </button>
            )}
            <span className="st-muted st-small">Graba cada micrófono seguido, con su silencio y cuenta regresiva.</span>
          </div>
        )}

        {studio.candidates.length > 0 && (
          <div className="st-table-wrap">
            <table className="st-table">
              <thead>
                <tr>
                  <th />
                  <th>Micrófono</th>
                  <th title="Mediana en silencio · ponderado A debajo">Ruido</th>
                  <th title="RMS de las partes con voz · sonoridad integrada debajo">Nivel</th>
                  <th title="Pico por muestra · true peak (4×) debajo">Pico</th>
                  <th>SNR</th>
                  <th>Cresta</th>
                  <th title="Centroide espectral · tono medio de la voz debajo">Brillo</th>
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
                  const takeNo = withTakes.findIndex((x) => x.id === c.id)
                  return (
                    <tr key={c.id} className={`${bestTech?.id === c.id ? 'best' : ''} ${playing === c.id ? 'playing' : ''}`}>
                      <td>
                        <span className="st-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                        {takeNo >= 0 && takeNo < 9 && <div className="st-key">{takeNo + 1}</div>}
                      </td>
                      <td>
                        <input className="st-name" value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} />
                        <div className="st-muted st-small">
                          {devices.find((d) => d.deviceId === c.deviceId)?.label ?? (c.deviceId ? 'Dispositivo no conectado' : 'Predeterminado')} ·{' '}
                          {c.channel === 'mix' ? 'mezcla' : `canal ${c.channel + 1}`} · trim {c.gainDb} dB
                        </div>
                        <input className="st-name st-notes" placeholder="Observaciones (posición, preamp…)" value={c.notes ?? ''} onChange={(e) => patch(c.id, { notes: e.target.value })} />
                        {m?.envelope && <Waveform env={m.envelope} color={COLORS[i % COLORS.length]} />}
                      </td>
                      <td>
                        {m ? m.noiseFloorDb.toFixed(1) : '—'}
                        {m?.noiseADb !== undefined && <div className="st-muted st-small">A: {m.noiseADb.toFixed(1)}</div>}
                        {m?.hum && <div className="st-small bad">~{m.hum.hz} Hz</div>}
                      </td>
                      <td>
                        {m ? m.levelDb.toFixed(1) : '—'}
                        {m?.lufs !== undefined && <div className="st-muted st-small">{m.lufs > -70 ? `${m.lufs.toFixed(1)} LUFS` : '—'}</div>}
                      </td>
                      <td>
                        {m ? m.peakDb.toFixed(1) : '—'}
                        {m?.truePeakDb !== undefined && <div className={`st-small ${m.truePeakDb > -1 ? 'bad' : 'st-muted'}`}>TP {m.truePeakDb.toFixed(1)}</div>}
                      </td>
                      <td className={m ? (m.snrDb > 40 ? 'ok' : m.snrDb > 25 ? 'warn' : 'bad') : ''}>{m ? `${m.snrDb.toFixed(1)} dB` : '—'}</td>
                      <td>{m ? m.crestDb.toFixed(1) : '—'}</td>
                      <td>
                        {m ? `${(m.centroidHz / 1000).toFixed(2)} kHz` : '—'}
                        {m?.pitchHz ? (
                          <div className="st-muted st-small">
                            voz {m.pitchHz} Hz · {noteInfo(m.pitchHz).solfege}
                          </div>
                        ) : null}
                      </td>
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
                      <td className={m?.clipCount || m?.clippedSamples ? 'bad' : ''} title="Lecturas saturadas · muestras a 0 dBFS">
                        {m ? m.clipCount : '—'}
                        {m?.clippedSamples ? <div className="st-small">{m.clippedSamples} muestras</div> : null}
                      </td>
                      <td title={score ? `SNR ${score.snr}/55 · nivel ${score.level}/15 · saturación ${score.clipping}/15 · balance ${score.balance}/15\n${score.notes.join('\n')}` : undefined}>
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
                      <td>
                        <div className="st-actions">
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
                                {playing === c.id && !groupOn ? '■' : '▶'}
                              </button>
                              <button className="st-btn" disabled={!takeStore.has(c.id)} onClick={() => exportWav(c)} title="Exportar WAV">
                                WAV
                              </button>
                              <span className="st-updown">
                                <button className="st-btn ghost" disabled={busy || i === 0} onClick={() => move(c.id, -1)} title="Subir">
                                  ▲
                                </button>
                                <button className="st-btn ghost" disabled={busy || i === studio.candidates.length - 1} onClick={() => move(c.id, 1)} title="Bajar">
                                  ▼
                                </button>
                              </span>
                              <button
                                className="st-btn ghost"
                                disabled={busy}
                                onClick={() => {
                                  if (c.metrics && !confirm(`¿Quitar «${c.name}» y su medición?`)) return
                                  takeStore.delete(c.id)
                                  setCandidates((cs) => cs.filter((x) => x.id !== c.id))
                                  if (studio.referenceId === c.id) update('studio', (s) => ({ ...s, referenceId: null }))
                                  force((n) => n + 1)
                                }}
                              >
                                ✕
                              </button>
                            </>
                          )}
                        </div>
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
            <button className="st-btn" onClick={exportPdf}>
              Informe PDF
            </button>
            <button
              className={`st-btn ${groupOn && !blind ? 'on' : ''}`}
              disabled={withTakes.length < 2 || busy}
              onClick={() => (groupOn ? stopPlayback() : startSynced(withTakes.map((c) => c.id)))}
              title="Reproduce todas las tomas a la vez en bucle y cambia entre ellas al instante con 1–9"
            >
              {groupOn && !blind ? '■ Detener A/B' : '⇄ A/B sincronizado'}
            </button>
            <button className="st-btn primary" disabled={withTakes.length < 2 || busy} onClick={startBlind}>
              Prueba a ciegas
            </button>
          </div>
        )}
        {groupOn && !blind && (
          <div className="st-row st-ab">
            {withTakes.map((c, i) => (
              <button key={c.id} className={`st-btn ${playing === c.id ? 'primary' : ''}`} onClick={() => play(c.id)}>
                {i + 1}. {c.name}
              </button>
            ))}
            <span className="st-muted st-small">Cambio instantáneo en el mismo punto de la toma{studio.matchLoudness ? ', volumen igualado' : ''}.</span>
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
            <span className="st-muted">Orden aleatorio{studio.matchLoudness ? ', volumen igualado' : ''}. Escucha y califica sin saber cuál es cuál (teclas 1–9).</span>
          </header>
          <div className="st-blind">
            {blind.order.map((id, i) => {
              const c = studio.candidates.find((x) => x.id === id)
              return (
                <div key={id} className={`st-blind-item ${playing === id ? 'playing' : ''}`}>
                  <b>
                    Muestra {String.fromCharCode(65 + i)} <span className="st-muted st-small">({i + 1})</span>
                  </b>
                  <button className="st-btn" onClick={() => play(id)}>
                    {playing === id && !groupOn ? '■ Detener' : '▶ Escuchar'}
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
            <button className="st-btn" onClick={() => (groupOn ? stopPlayback() : startSynced(blind.order))} title="Todas las muestras a la vez; 1–9 cambia al instante">
              {groupOn ? '■ Detener sincronizado' : '⇄ Escuchar sincronizado'}
            </button>
            {!blind.revealed ? (
              <button className="st-btn primary" disabled={Object.keys(blind.ratings).length < blind.order.length} onClick={reveal}>
                Revelar resultados
              </button>
            ) : (
              <button className="st-btn" onClick={startBlind}>
                Repetir prueba
              </button>
            )}
            <button
              className="st-btn ghost"
              onClick={() => {
                stopPlayback()
                setBlind(null)
              }}
            >
              Cerrar
            </button>
          </div>
        </section>
      )}

      {measured.length > 0 && <ResponsePanel candidates={studio.candidates} referenceId={studio.referenceId} onReference={(id) => update('studio', (s) => ({ ...s, referenceId: id }))} />}
    </div>
  )
}

function ResponsePanel({ candidates, referenceId, onReference }: { candidates: MicCandidate[]; referenceId: string | null; onReference: (id: string | null) => void }): JSX.Element {
  const [smooth, setSmooth] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const ref = candidates.find((c) => c.id === referenceId && c.metrics)
  const curveOf = (c: MicCandidate): number[] => {
    let curve = c.metrics!.curve
    if (ref) curve = curveDifference(curve, ref.metrics!.curve)
    return smooth ? smoothCurve(curve) : curve
  }
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>{ref ? `Diferencia respecto a «${ref.name}»` : 'Respuesta en frecuencia (tercios de octava, normalizada)'}</h2>
        <div className="st-row">
          <label className="st-inline">
            Comparar contra
            <select value={ref?.id ?? ''} onChange={(e) => onReference(e.target.value || null)}>
              <option value="">— curvas absolutas —</option>
              {candidates
                .filter((c) => c.metrics)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="st-inline">
            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
            Suavizar
          </label>
        </div>
      </header>
      <span className="st-muted st-small">
        {ref
          ? 'Por encima de 0 = ese micro realza esas frecuencias frente a la referencia; por debajo = las atenúa.'
          : 'Compara la forma: curva más alta en una zona = ese micro realza esas frecuencias. Clic en la leyenda para ocultar curvas.'}
      </span>
      <ResponseChart
        series={candidates.flatMap((c, ci) => (c.metrics && !hidden.has(c.id) ? [{ id: c.id, color: COLORS[ci % COLORS.length], curve: curveOf(c), dashed: c.id === ref?.id }] : []))}
        range={ref ? [-15, 15] : [-30, 15]}
      />
      <div className="st-legend">
        {candidates.map((c, ci) =>
          c.metrics ? (
            <button
              key={c.id}
              className={hidden.has(c.id) ? 'off' : ''}
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h)
                  if (n.has(c.id)) n.delete(c.id)
                  else n.add(c.id)
                  return n
                })
              }
            >
              <i style={{ background: COLORS[ci % COLORS.length] }} />
              {c.name}
            </button>
          ) : null
        )}
      </div>
    </section>
  )
}

function ResponseChart({ series, range }: { series: { id: string; color: string; curve: number[]; dashed?: boolean }[]; range: [number, number] }): JSX.Element {
  const W = 900
  const H = 260
  const PAD = { l: 40, r: 12, t: 10, b: 26 }
  const [MIN, MAX] = range
  const x = (i: number): number => PAD.l + (i / (BAND_CENTERS.length - 1)) * (W - PAD.l - PAD.r)
  const y = (db: number): number => PAD.t + ((MAX - Math.max(MIN, Math.min(MAX, db))) / (MAX - MIN)) * (H - PAD.t - PAD.b)
  const ticks = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]
  const grid: number[] = []
  for (let d = Math.ceil(MIN / 5) * 5; d <= MAX; d += MAX - MIN > 30 ? 10 : 5) grid.push(d)
  return (
    <svg className="st-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {grid.map((d) => (
        <g key={d}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(d)} y2={y(d)} className={d === 0 ? 'zero' : 'grid'} />
          <text x={PAD.l - 6} y={y(d) + 4} textAnchor="end">
            {d}
          </text>
        </g>
      ))}
      {ticks.map((f) => {
        const i = BAND_CENTERS.indexOf(f)
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
      {series.map((s) => (
        <polyline
          key={s.id}
          fill="none"
          stroke={s.color}
          strokeWidth="2.5"
          strokeDasharray={s.dashed ? '6 4' : undefined}
          strokeLinejoin="round"
          points={s.curve.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
        />
      ))}
    </svg>
  )
}

/** Peak envelope thumbnail; red marks samples near full scale */
function Waveform({ env, color }: { env: number[]; color: string }): JSX.Element {
  const W = env.length
  const H = 24
  return (
    <svg className="st-wave" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {env.map((v, i) => {
        const h = Math.max(0.5, v * H)
        return <rect key={i} x={i} y={(H - h) / 2} width={0.8} height={h} fill={v >= 0.99 ? '#ff4d4d' : color} />
      })}
    </svg>
  )
}
