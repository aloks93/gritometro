import { useEffect, useRef, useState } from 'react'
import { createProfile, isVirtualDevice } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { autoProfileSwitch, describeProbe, probeFrom, profileNameFor, profilesForDevice, type DeviceProbe } from '../../core/studio/hardware'
import { useEngineState } from '../hooks'
import { useStore } from '../store'
import { useStudioPrefs } from './MonitorView'
import { Readout } from './widgets'

interface Devices {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

const realDevice = (d: MediaDeviceInfo): boolean => d.deviceId !== 'default' && d.deviceId !== 'communications'

function useDevices(): Devices {
  const [devices, setDevices] = useState<Devices>({ inputs: [], outputs: [] })
  useEffect(() => {
    const load = (): void => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setDevices({ inputs: d.filter((x) => x.kind === 'audioinput' && realDevice(x)), outputs: d.filter((x) => x.kind === 'audiooutput' && realDevice(x)) }))
        .catch(() => undefined)
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])
  return devices
}

/** Opens a device for a moment to ask what it supports */
async function probeDevice(deviceId: string): Promise<DeviceProbe> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 32 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false
  })
  try {
    const track = stream.getAudioTracks()[0]
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
    return probeFrom(caps, track.getSettings() as Record<string, unknown>)
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

/** Switches the audio profile when devices come and go (if enabled in the Equipos tab) */
export function useAutoProfile(): string {
  const { data, update } = useStore()
  const [note, setNote] = useState('')
  const latest = useRef(data)
  latest.current = data
  useEffect(() => {
    let known: string[] | null = null
    const check = (): void => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          const present = list.filter((x) => x.kind === 'audioinput' && realDevice(x)).map((x) => x.deviceId)
          const added = known ? present.filter((id) => !known!.includes(id)) : []
          const first = known === null
          known = present
          const d = latest.current
          if (first || !d.studio.prefs.autoProfile) return
          const next = autoProfileSwitch(d.audio.profiles, d.audio.activeProfileId, present, added)
          if (!next) return
          const p = d.audio.profiles.find((x) => x.id === next)
          update('audio', (a) => ({ ...a, activeProfileId: next }))
          setNote(`Perfil cambiado a «${p?.name}» porque cambió el equipo conectado.`)
          setTimeout(() => setNote(''), 8000)
        })
        .catch(() => undefined)
    }
    check()
    navigator.mediaDevices?.addEventListener('devicechange', check)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', check)
  }, [update])
  return note
}

export function DevicesView(): JSX.Element {
  const { data, update } = useStore()
  const [prefs, setPrefs] = useStudioPrefs()
  const engine = useEngineState()
  const { inputs, outputs } = useDevices()
  const [probes, setProbes] = useState<Record<string, DeviceProbe | string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const audio = data.audio
  const lat = audioEngine.reportedLatency()

  const probe = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const p = await probeDevice(id)
      setProbes((m) => ({ ...m, [id]: p }))
    } catch (err) {
      setProbes((m) => ({ ...m, [id]: err instanceof DOMException && err.name === 'NotReadableError' ? 'Ocupado por otra aplicación.' : 'No se pudo abrir.' }))
    } finally {
      setBusy(null)
    }
  }

  const probeAll = async (): Promise<void> => {
    for (const d of inputs) await probe(d.deviceId)
  }

  const createFor = (d: MediaDeviceInfo): void => {
    const p = probes[d.deviceId]
    const rate = typeof p === 'object' && p.sampleRate ? p.sampleRate : 48000
    const profile = createProfile(profileNameFor(d.label), { deviceId: d.deviceId, disableProcessing: true, sampleRate: rate })
    update('audio', (a) => ({ ...a, profiles: [...a.profiles, profile], activeProfileId: profile.id }))
  }

  return (
    <div className="st-devices">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Motor de audio</h2>
          <label className="st-inline" title="Al conectar un equipo con perfil propio se activa ese perfil; si desconectas el del perfil activo, pasa a otro disponible">
            <input type="checkbox" checked={prefs.autoProfile} onChange={(e) => setPrefs({ autoProfile: e.target.checked })} />
            Cambiar de perfil automáticamente al conectar/desconectar
          </label>
        </header>
        <div className="st-readouts">
          <Readout label="Entrada abierta" value={engine.status === 'running' ? (engine.label ?? '—') : 'Ninguna'} unit="" />
          <Readout label="Muestreo real" value={engine.sampleRate ? String(engine.sampleRate / 1000) : '—'} unit="kHz" />
          <Readout label="Canales" value={String(engine.channelCount ?? '—')} unit="" />
          <Readout label="Latencia base" value={lat ? lat.baseMs.toFixed(1) : '—'} unit="ms" />
          <Readout label="Latencia de salida" value={lat ? lat.outputMs.toFixed(1) : '—'} unit="ms" />
          <Readout label="Modo de audio" value={audio.mode === 'advanced' ? 'Avanzado' : 'Simple'} unit="" />
        </div>
        <p className="st-muted st-small">
          Electron/Chromium usa WASAPI en Windows (CoreAudio en macOS, ALSA/Pulse en Linux): no se puede elegir ASIO ni fijar el tamaño de búfer, solo pedir latencia
          «interactiva/equilibrada/reproducción» y muestreo fijo (pestaña Entrada, modo avanzado). La latencia de ida y vuelta real se mide en el Generador.
        </p>
      </section>

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Entradas conectadas ({inputs.length})</h2>
          <button className="st-btn" disabled={!!busy || inputs.length === 0} onClick={() => void probeAll()}>
            {busy ? 'Analizando…' : 'Analizar todas'}
          </button>
        </header>
        <table className="st-table">
          <thead>
            <tr>
              <th>Equipo</th>
              <th>Capacidades</th>
              <th>Perfil</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {inputs.map((d) => {
              const owned = profilesForDevice(audio.profiles, d.deviceId)
              const p = probes[d.deviceId]
              const active = owned.some((x) => x.id === audio.activeProfileId)
              return (
                <tr key={d.deviceId} className={active ? 'st-row-active' : ''}>
                  <td>
                    {d.label || 'Entrada sin nombre'}
                    {isVirtualDevice(d.label) && <span className="st-tag">virtual</span>}
                    {active && <span className="st-tag on">en uso</span>}
                  </td>
                  <td className="st-small">
                    {p === undefined ? (
                      <button className="st-btn ghost" disabled={!!busy} onClick={() => void probe(d.deviceId)}>
                        {busy === d.deviceId ? 'Analizando…' : 'Analizar'}
                      </button>
                    ) : typeof p === 'string' ? (
                      <span className="warn">{p}</span>
                    ) : (
                      <>
                        {describeProbe(p)}
                        {p.processing.length > 0 && <div className="st-muted">Procesamiento de Windows disponible: {p.processing.join(', ')} (el perfil lo apaga)</div>}
                      </>
                    )}
                  </td>
                  <td>
                    {owned.length === 0 ? (
                      <span className="st-muted st-small">Sin perfil</span>
                    ) : (
                      owned.map((o) => (
                        <button key={o.id} className={`st-btn ${o.id === audio.activeProfileId ? 'on' : 'ghost'}`} onClick={() => update('audio', (a) => ({ ...a, activeProfileId: o.id }))}>
                          {o.name}
                        </button>
                      ))
                    )}
                  </td>
                  <td>
                    <button className="st-btn" onClick={() => createFor(d)} title="Crea un perfil para este equipo (sin procesamiento de Windows) y lo activa">
                      + Perfil
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {inputs.length === 0 && <p className="st-muted">No hay entradas: conecta un micrófono o una interfaz.</p>}
        <p className="st-muted st-small">Cada perfil guarda su calibración, ganancia y ruido de fondo: crea uno por micrófono/interfaz y cambia entre ellos sin volver a ajustar nada.</p>
      </section>

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Salidas conectadas ({outputs.length})</h2>
        </header>
        <table className="st-table">
          <tbody>
            {outputs.map((d) => (
              <tr key={d.deviceId} className={prefs.outputDeviceId === d.deviceId ? 'st-row-active' : ''}>
                <td>
                  {d.label || 'Salida sin nombre'}
                  {isVirtualDevice(d.label) && <span className="st-tag">virtual</span>}
                </td>
                <td>
                  {prefs.outputDeviceId === d.deviceId ? (
                    <span className="st-tag on">salida del estudio</span>
                  ) : (
                    <button className="st-btn ghost" onClick={() => setPrefs({ outputDeviceId: d.deviceId })}>
                      Usar para escucha y generador
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="st-muted st-small">Las salidas de los buses del mezclador se eligen en cada bus (pestaña Mezclador).</p>
      </section>
    </div>
  )
}
