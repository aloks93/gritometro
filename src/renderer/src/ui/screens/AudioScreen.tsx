import { useCallback, useEffect, useRef, useState } from 'react'
import { activeProfile, createProfile, type AudioProfile, type AudioSettings } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noiseFloorFrom } from '../../core/audio/Calibration'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import { Field, Panel, Screen, Slider } from '../components/Layout'
import { useEngineState, useReading } from '../hooks'
import type { Navigate } from '../nav'
import { useStore } from '../store'

const DB_MIN = -90

/** Horizontal dBFS bar with noise-floor marker and clip LED */
function LevelBar({ floor }: { floor: number }): JSX.Element {
  const r = useReading()
  const [peakHold, setPeakHold] = useState(DB_MIN)
  const [clipUntil, setClipUntil] = useState(0)
  useEffect(() => {
    if (!r) return
    setPeakHold((p) => Math.max(r.peakDb, p - 0.5))
    if (r.clipped) setClipUntil(r.t + 1500)
  }, [r])
  const pct = (db: number): number => Math.min(100, Math.max(0, ((db - DB_MIN) / -DB_MIN) * 100))
  const clipping = r ? r.t < clipUntil : false
  return (
    <div className="level-bar-wrap">
      <div className="level-bar">
        <div className="level-bar-fill" style={{ width: `${pct(r?.smoothedDb ?? DB_MIN)}%` }} />
        <div className="level-bar-peak" style={{ left: `${pct(peakHold)}%` }} />
        <div className="level-bar-floor" style={{ left: `${pct(floor)}%` }} title="Ruido ambiente" />
      </div>
      <span className={`clip-led ${clipping ? 'on' : ''}`}>CLIP</span>
      <div className="level-bar-scale">
        {[-90, -72, -54, -36, -18, -6, 0].map((d) => (
          <span key={d} style={{ left: `${pct(d)}%` }}>
            {d}
          </span>
        ))}
      </div>
    </div>
  )
}

function TechnicalMeter({ profile }: { profile: AudioProfile }): JSX.Element {
  const r = useReading()
  const engine = useEngineState()
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      const c = canvas.current
      const data = audioEngine.spectrum()
      if (c && data) {
        const g = c.getContext('2d')!
        g.clearRect(0, 0, c.width, c.height)
        const bins = 96
        const w = c.width / bins
        // Log-ish frequency axis so voice range gets most of the width
        for (let i = 0; i < bins; i++) {
          const idx = Math.floor(Math.pow(i / bins, 2) * (data.length - 1))
          const v = data[idx] / 255
          g.fillStyle = `hsl(${180 - v * 140} 85% 55%)`
          g.fillRect(i * w, c.height * (1 - v), w - 1, c.height * v)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  const fmt = (v?: number): string => (v === undefined || v <= -100 ? '-∞' : v.toFixed(1))
  return (
    <div className="tech-meter">
      <div className="tech-grid">
        <div>
          <small>RMS</small>
          <b>{fmt(r?.rmsDb)} dBFS</b>
        </div>
        <div>
          <small>Pico</small>
          <b>{fmt(r?.peakDb)} dBFS</b>
        </div>
        <div>
          <small>Medidor</small>
          <b>{fmt(r?.smoothedDb)} dBFS</b>
        </div>
        <div>
          <small>SPL aprox.</small>
          <b>{r ? Math.round(r.smoothedDb + profile.splOffset) : '—'} dB</b>
        </div>
        <div>
          <small>Canales</small>
          <b>{engine.channelCount ?? '—'}</b>
        </div>
        <div>
          <small>Muestreo</small>
          <b>{engine.sampleRate ? `${engine.sampleRate / 1000} kHz` : '—'}</b>
        </div>
      </div>
      <canvas ref={canvas} width={640} height={120} className="spectrum" />
    </div>
  )
}

export function AudioScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update } = useStore()
  const audio = data.audio
  const profile = activeProfile(audio)
  const engine = useEngineState()
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [calibrating, setCalibrating] = useState(false)
  const [newName, setNewName] = useState('')
  const advanced = audio.mode === 'advanced'

  const refresh = useCallback(() => {
    listInputs()
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [])

  useEffect(() => {
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  const setAudio = (patch: Partial<AudioSettings>): void => update('audio', (a) => ({ ...a, ...patch }))
  const setProfile = (patch: Partial<AudioProfile>): void =>
    update('audio', (a) => ({ ...a, profiles: a.profiles.map((p) => (p.id === a.activeProfileId ? { ...p, ...patch } : p)) }))

  const calibrate = async (): Promise<void> => {
    setCalibrating(true)
    const frames = await audioEngine.record(2500)
    // No readings = the mic stopped meanwhile: keep the previous floor instead of a made-up one
    if (frames.length > 0) setProfile({ noiseFloorDb: noiseFloorFrom(frames) })
    setCalibrating(false)
  }

  const addProfile = (template: 'blank' | 'voicemeeter' | 'console'): void => {
    const vm = devices.find((d) => /voicemeeter (out|output)/i.test(d.label)) ?? devices.find((d) => d.virtual)
    const presets: Record<typeof template, Partial<AudioProfile>> = {
      blank: {},
      voicemeeter: { deviceId: vm?.deviceId ?? null, disableProcessing: true, ballistics: 'fast', sampleRate: 48000 },
      console: { channel: 0, disableProcessing: true, sampleRate: 48000, ballistics: 'vu' }
    }
    const defaultNames = { blank: 'Nuevo perfil', voicemeeter: 'VoiceMeeter Banana', console: 'Consola / interfaz USB' }
    const p = createProfile(newName.trim() || defaultNames[template], presets[template])
    update('audio', (a) => ({ ...a, profiles: [...a.profiles, p], activeProfileId: p.id }))
    setNewName('')
  }

  const deleteProfile = (): void => {
    if (audio.profiles.length <= 1) return
    if (!confirm(`¿Eliminar el perfil "${profile.name}"?`)) return
    update('audio', (a) => {
      const profiles = a.profiles.filter((p) => p.id !== a.activeProfileId)
      return { ...a, profiles, activeProfileId: profiles[0].id }
    })
  }

  const deviceExists = !profile.deviceId || devices.some((d) => d.deviceId === profile.deviceId)

  return (
    <Screen
      title="🎤 Audio"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <div className="segmented">
          <button className={!advanced ? 'on' : ''} onClick={() => setAudio({ mode: 'simple' })}>
            Sencillo
          </button>
          <button className={advanced ? 'on' : ''} onClick={() => setAudio({ mode: 'advanced' })}>
            Avanzado
          </button>
        </div>
      }
    >
      <Panel title="Micrófono">
        <div className="row">
          <select
            className="grow"
            value={profile.deviceId ?? ''}
            onChange={(e) => setProfile({ deviceId: e.target.value || null })}
          >
            <option value="">Predeterminado de Windows</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
                {advanced && d.virtual ? '  [virtual]' : ''}
              </option>
            ))}
          </select>
          <button className="btn" onClick={refresh}>
            ↻ Actualizar
          </button>
          <button className="btn" onClick={() => audioEngine.restart()}>
            Reconectar
          </button>
        </div>
        {!deviceExists && <p className="error">El micrófono guardado no está conectado. Elige otro o conéctalo.</p>}
        <p className={`status-line status-${engine.status}`}>
          {engine.status === 'running' && `✅ Escuchando: ${engine.label}`}
          {engine.status === 'starting' && '⏳ Abriendo micrófono...'}
          {(engine.status === 'error' || engine.status === 'disconnected') && `⚠️ ${engine.error}`}
          {engine.status === 'idle' && 'Micrófono apagado'}
        </p>
        <LevelBar floor={profile.noiseFloorDb} />
        <div className="row">
          <button className="btn primary" onClick={calibrate} disabled={calibrating || engine.status !== 'running'}>
            {calibrating ? '🤫 Midiendo ruido... ¡silencio!' : '📏 Calibrar ruido ambiente'}
          </button>
          <span className="muted">Ruido ambiente: {profile.noiseFloorDb.toFixed(1)} dBFS</span>
        </div>
        <p className="field-hint">Calibra con el ruido normal de la fiesta (música y gente), sin que nadie grite al micrófono.</p>
      </Panel>

      {advanced && (
        <>
          <Panel title="Perfiles de audio">
            <div className="row">
              <select className="grow" value={audio.activeProfileId} onChange={(e) => setAudio({ activeProfileId: e.target.value })}>
                {audio.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input value={profile.name} onChange={(e) => setProfile({ name: e.target.value })} placeholder="Nombre del perfil" />
              <button className="btn danger" disabled={audio.profiles.length <= 1} onClick={deleteProfile}>
                Eliminar
              </button>
            </div>
            <div className="row">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre del nuevo perfil (opcional)" className="grow" />
              <button className="btn" onClick={() => addProfile('blank')}>
                + Vacío
              </button>
              <button className="btn" onClick={() => addProfile('voicemeeter')}>
                + VoiceMeeter
              </button>
              <button className="btn" onClick={() => addProfile('console')}>
                + Consola USB
              </button>
            </div>
          </Panel>

          <div className="two-col">
            <Panel title="Entrada">
              <Field label="Canal" hint={`El dispositivo reporta ${engine.channelCount ?? '?'} canal(es). En consolas USB cada entrada suele ser un canal.`}>
                <div className="row">
                  <select
                    value={profile.channel === 'mix' ? 'mix' : 'ch'}
                    onChange={(e) => setProfile({ channel: e.target.value === 'mix' ? 'mix' : 0 })}
                  >
                    <option value="mix">Mezcla de todos los canales</option>
                    <option value="ch">Un canal específico</option>
                  </select>
                  {profile.channel !== 'mix' && (
                    <select value={profile.channel} onChange={(e) => setProfile({ channel: Number(e.target.value) })}>
                      {Array.from({ length: Math.max(engine.channelCount ?? 2, 2) }, (_, i) => (
                        <option key={i} value={i}>
                          Canal {i + 1}
                          {i === 0 ? ' (L)' : i === 1 ? ' (R)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </Field>
              <Field label="Procesamiento de Windows/Chromium" hint="Cancelación de eco, supresión de ruido y ganancia automática falsean la medición. Déjalo desactivado.">
                <label className="check">
                  <input type="checkbox" checked={profile.disableProcessing} onChange={(e) => setProfile({ disableProcessing: e.target.checked })} />
                  Desactivar procesamiento (recomendado)
                </label>
              </Field>
              <Field label="Frecuencia de muestreo">
                <select value={profile.sampleRate ?? ''} onChange={(e) => setProfile({ sampleRate: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Automática</option>
                  <option value="44100">44.1 kHz</option>
                  <option value="48000">48 kHz (VoiceMeeter / consolas)</option>
                  <option value="96000">96 kHz</option>
                </select>
              </Field>
              <Field label="Latencia">
                <select value={profile.latency} onChange={(e) => setProfile({ latency: e.target.value as AudioProfile['latency'] })}>
                  <option value="interactive">Mínima</option>
                  <option value="balanced">Equilibrada</option>
                  <option value="playback">Alta (más estable)</option>
                </select>
              </Field>
            </Panel>

            <Panel title="Nivel y medición">
              <Field label="Ganancia digital (trim)" hint="Si el LED CLIP se enciende, baja la ganancia aquí o en la consola/VoiceMeeter.">
                <Slider value={profile.gainDb} min={-24} max={24} onChange={(v) => setProfile({ gainDb: v })} format={(v) => `${v > 0 ? '+' : ''}${v} dB`} />
              </Field>
              <Field label="Puerta de ruido (gate)" hint="Lo que esté por debajo se considera silencio total.">
                <Slider value={profile.gateDb} min={-100} max={-30} onChange={(v) => setProfile({ gateDb: v })} format={(v) => `${v} dBFS`} />
              </Field>
              <Field label="Respuesta del medidor">
                <select value={profile.ballistics} onChange={(e) => setProfile({ ballistics: e.target.value as AudioProfile['ballistics'] })}>
                  <option value="fast">Rápida (juego)</option>
                  <option value="vu">VU (suave, 300 ms)</option>
                  <option value="peak">Pico (PPM)</option>
                </select>
              </Field>
              <Field label="Calibración a dB SPL" hint="Pon un sonómetro (app del celular) junto al micro, haz un sonido constante y ajusta hasta que coincidan.">
                <Slider value={profile.splOffset} min={60} max={160} onChange={(v) => setProfile({ splOffset: v })} format={(v) => `dBFS + ${v}`} />
              </Field>
              <Field label="Ruido ambiente manual">
                <Slider value={profile.noiseFloorDb} min={-100} max={-20} step={0.5} onChange={(v) => setProfile({ noiseFloorDb: v })} format={(v) => `${v} dBFS`} />
              </Field>
              <label className="check">
                <input type="checkbox" checked={audio.showTechnicalMeter} onChange={(e) => setAudio({ showTechnicalMeter: e.target.checked })} />
                Mostrar medidor técnico
              </label>
            </Panel>
          </div>

          {audio.showTechnicalMeter && (
            <Panel title="Medidor técnico">
              <TechnicalMeter profile={profile} />
            </Panel>
          )}

          <Panel title="Guía: VoiceMeeter Banana y consolas">
            <details>
              <summary>VoiceMeeter Banana</summary>
              <ol>
                <li>En VoiceMeeter, pon tu micrófono en <b>Hardware Input 1</b> (o la entrada que uses).</li>
                <li>Activa el botón <b>B1</b> de esa tira para enviarlo al bus virtual.</li>
                <li>
                  Aquí elige <b>VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)</b> como micrófono. Para el bus B2 usa <b>VoiceMeeter Aux Output</b>.
                </li>
                <li>Pon la frecuencia en 48 kHz (igual que VoiceMeeter → Menu → System Settings).</li>
                <li>No subas el fader de la tira por encima de 0 dB o saturará: mira el LED CLIP.</li>
                <li>Puedes aplicar EQ/compresor en VoiceMeeter, pero un compresor fuerte iguala a todos: mejor dejarlo apagado para el reto.</li>
              </ol>
            </details>
            <details>
              <summary>Consola / mezcladora / interfaz USB</summary>
              <ol>
                <li>Conecta la consola por USB; aparecerá como un dispositivo de entrada (p. ej. "USB Audio CODEC").</li>
                <li>Si tiene varias entradas por USB, elige "Un canal específico" y el canal del micrófono.</li>
                <li>Si solo envía el master estéreo por USB, usa "Mezcla" y baja el resto de canales en la consola.</li>
                <li>Ajusta la ganancia (gain/trim) de la consola para que un grito fuerte no encienda el LED CLIP.</li>
                <li>Calibra el ruido ambiente después de ajustar la consola.</li>
              </ol>
            </details>
          </Panel>
        </>
      )}
    </Screen>
  )
}
