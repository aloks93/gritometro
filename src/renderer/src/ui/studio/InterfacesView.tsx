import { useEffect, useRef, useState } from 'react'
import { inputScanner, type ScanDevice, type ScanState } from '../../core/audio/InputScanner'
import { processorEngine } from '../../core/audio/ProcessorEngine'
import { gainAdvice } from '../../core/mixer/mixer'
import {
  ActivityTracker,
  chainSummary,
  channelKey,
  channelView,
  copyChannel,
  forgetChannel,
  parseChannelKey,
  resetChannel,
  setChannelInfo,
  switchChannel,
  type Activity,
  type ChannelInput
} from '../../core/processor/channels'
import { GAIN_MAX, GAIN_MIN, type ProcessorConfig } from '../../core/processor/processor'
import { useStore } from '../store'
import { Icon, Knob, useFrame } from './controls'
import { useProcessorState } from './ProcessorView'
import './processor.css'
import './interfaces.css'

// Every connected input at once, channel by channel. Clicking a channel loads it in the
// processor: the channel you were editing is stored as it was, the new one comes back with
// its own settings. One channel is worked on at a time; the others keep theirs.

function useScan(): ScanState {
  const [s, set] = useState(inputScanner.state)
  useEffect(() => {
    const off = inputScanner.onState(set)
    void inputScanner.start()
    return () => {
      off()
      inputScanner.stop()
    }
  }, [])
  return s
}

type SetFn = (fn: (c: ProcessorConfig) => ProcessorConfig) => void

const STATUS_TEXT: Record<ScanDevice['status'], string> = {
  ok: 'Conectada',
  busy: 'Ocupada por otro programa',
  missing: 'No disponible',
  denied: 'Sin permiso',
  error: 'Error'
}

export function InterfacesView({ onOpenProcessor }: { onOpenProcessor: () => void }): JSX.Element {
  const { data, update } = useStore()
  const cfg = data.processor
  const set: SetFn = (fn) => update('processor', fn)
  const scan = useScan()
  const proc = useProcessorState()
  const loadedKey = channelKey(cfg.input)

  const load = (input: ChannelInput): void => set((c) => switchChannel(c, input))
  const okDevices = scan.devices.filter((d) => d.status === 'ok')
  const totalChannels = okDevices.reduce((n, d) => n + d.channels, 0)
  const limited = okDevices.filter((d) => !d.virtual && d.channels <= 2 && (d.maxChannels ?? 0) <= 2)

  return (
    <div className="vp vp-ifaces">
      <header className="vp-head">
        <div className="vp-title">
          <b>Interfaces de audio</b>
          <span>Todas las entradas a la vez · pulsa un canal para trabajarlo en el procesador; el anterior se guarda tal cual</span>
        </div>
        <span className="vp-grow" />
        <div className="vp-readout-strip">
          <span>
            <small>Interfaces</small>
            <b>{okDevices.length}</b>
          </span>
          <span>
            <small>Canales</small>
            <b>{totalChannels}</b>
          </span>
          <span>
            <small>Ajustados</small>
            <b>{Object.keys(cfg.channels).length}</b>
          </span>
        </div>
        <button className="vp-btn" onClick={() => void inputScanner.start()} title="Volver a buscar interfaces">
          <Icon name="reset" size={15} />
          Volver a escanear
        </button>
      </header>

      {limited.length > 0 && (
        <p className="vp-msg">
          Algunas interfaces solo entregan 2 canales por el driver del sistema. Si tu interfaz o consola tiene más entradas, actívalas en el panel del fabricante (modo multicanal) o
          pásalas por VoiceMeeter.
        </p>
      )}

      <div className="vp-if-layout">
        <div className="vp-if-devices">
          {!scan.running && scan.devices.length === 0 && <section className="vp-panel vp-if-empty">Buscando interfaces…</section>}
          {scan.running && scan.devices.length === 0 && <section className="vp-panel vp-if-empty">No hay entradas de audio conectadas.</section>}
          {scan.devices.map((d) => (
            <DeviceCard key={d.deviceId} device={d} cfg={cfg} loadedKey={loadedKey} onLoad={load} />
          ))}
        </div>
        <ChannelDetail cfg={cfg} set={set} scan={scan} running={proc.status === 'on'} onOpenProcessor={onOpenProcessor} />
      </div>
    </div>
  )
}

function DeviceCard({ device, cfg, loadedKey, onLoad }: { device: ScanDevice; cfg: ProcessorConfig; loadedKey: string; onLoad: (i: ChannelInput) => void }): JSX.Element {
  useFrame(20)
  const trackers = useRef(new Map<number, ActivityTracker>())
  const last = useRef(performance.now())
  const now = performance.now()
  const dt = Math.min(200, now - last.current)
  last.current = now
  const levels = inputScanner.levels(device.deviceId)
  const act: Activity[] = levels.map((l, i) => {
    let t = trackers.current.get(i)
    if (!t) trackers.current.set(i, (t = new ActivityTracker()))
    return t.update(l.rms, l.peak, dt)
  })
  const ok = device.status === 'ok'
  const mixKey = channelKey({ deviceId: device.deviceId, channel: -1 })
  return (
    <section className={`vp-panel vp-if-device ${ok ? '' : 'off'}`}>
      <header className="vp-module-head">
        <b className="vp-if-name" title={device.label}>
          {device.label}
        </b>
        {device.virtual && <span className="vp-if-tag">Virtual</span>}
        <span className="vp-grow" />
        <span className={`vp-if-status ${device.status}`}>{STATUS_TEXT[device.status]}</span>
        {ok && device.sampleRate && <span className="vp-dim vp-mono">{(device.sampleRate / 1000).toFixed(1)} kHz</span>}
        {ok && (
          <span className="vp-dim vp-mono">{`${device.channels} ${device.channels === 1 ? 'canal' : 'canales'}`}</span>
        )}
      </header>
      {ok ? (
        <div className="vp-if-channels">
          {levels.map((l, i) => {
            const key = channelKey({ deviceId: device.deviceId, channel: i })
            return <ChannelTile key={i} index={i} cfg={cfg} chKey={key} loaded={key === loadedKey} peak={l.peak} rms={l.rms} act={act[i]} onClick={() => onLoad({ deviceId: device.deviceId, channel: i })} />
          })}
          {device.channels > 1 && (
            <button className={`vp-if-tile vp-if-mix ${mixKey === loadedKey ? 'loaded' : ''}`} onClick={() => onLoad({ deviceId: device.deviceId, channel: -1 })} title="Todos los canales mezclados en uno">
              <span className="vp-if-num">Σ</span>
              <b>Mezcla</b>
              <small>{cfg.channels[mixKey] || mixKey === loadedKey ? 'Ajustado' : 'Todos los canales'}</small>
            </button>
          )}
        </div>
      ) : (
        <p className="vp-dim">{device.status === 'busy' ? 'Otro programa la usa en modo exclusivo: ciérralo o desactiva el modo exclusivo en Windows.' : device.error}</p>
      )}
    </section>
  )
}

function ChannelTile({ index, cfg, chKey, loaded, peak, rms, act, onClick }: { index: number; cfg: ProcessorConfig; chKey: string; loaded: boolean; peak: number; rms: number; act: Activity; onClick: () => void }): JSX.Element {
  const setup = cfg.channels[chKey]
  const name = setup?.name ?? ''
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  const summary = setup ? chainSummary(setup).join(' · ') : ''
  return (
    <button className={`vp-if-tile ${loaded ? 'loaded' : ''} ${act.signal ? 'signal' : ''}`} onClick={onClick} title={summary || 'Sin ajustes guardados'}>
      <span className="vp-if-num">{index + 1}</span>
      <span className={`vp-if-led ${act.clip ? 'clip' : act.signal ? 'on' : ''}`} />
      <b>{name || `Canal ${index + 1}`}</b>
      <div className="vp-if-meter">
        <i style={{ clipPath: `inset(0 ${100 - pct(peak)}% 0 0)` }} />
        <em style={{ width: `${pct(rms)}%` }} />
        <s style={{ left: `${pct(act.holdDb)}%` }} />
      </div>
      <small className="vp-mono">{act.holdDb <= -99 ? '—' : `${act.holdDb.toFixed(1)} dBFS`}</small>
      <small className="vp-if-badge">{loaded ? 'En el procesador' : setup ? 'Ajustado' : ''}</small>
    </button>
  )
}

function ChannelDetail({ cfg, set, scan, running, onOpenProcessor }: { cfg: ProcessorConfig; set: SetFn; scan: ScanState; running: boolean; onOpenProcessor: () => void }): JSX.Element {
  useFrame(10)
  const key = channelKey(cfg.input)
  const view = channelView(cfg, key)
  const device = scan.devices.find((d) => d.deviceId === cfg.input.deviceId)
  const raw = cfg.input.deviceId && cfg.input.channel >= 0 ? inputScanner.levels(cfg.input.deviceId)[cfg.input.channel] : undefined
  const hold = useRef({ v: -100, t: 0 })
  const now = performance.now()
  if (raw && (raw.peak > hold.current.v || now - hold.current.t > 3000)) hold.current = { v: raw.peak, t: now }
  const advice = raw ? gainAdvice(hold.current.v + cfg.inputGainDb, hold.current.v + cfg.inputGainDb) : null
  const others = Object.keys(cfg.channels).filter((k) => k !== key)
  const labelOf = (k: string): string => {
    const i = parseChannelKey(k)
    const d = scan.devices.find((x) => x.deviceId === i.deviceId)
    const ch = i.channel < 0 ? 'Mezcla' : `Canal ${i.channel + 1}`
    return `${cfg.channels[k]?.name || ch} · ${d?.label ?? (i.deviceId ? 'interfaz desconectada' : 'Entrada predeterminada')}`
  }
  const summary = view ? chainSummary(view) : []
  return (
    <aside className="vp-panel vp-if-detail">
      <h3>Canal en el procesador</h3>
      <div className="vp-if-detail-title">
        <b>{view?.name || (cfg.input.channel < 0 ? 'Mezcla' : `Canal ${cfg.input.channel + 1}`)}</b>
        <span className="vp-dim">{device?.label ?? (cfg.input.deviceId ? 'Interfaz no conectada' : 'Entrada predeterminada')}</span>
      </div>
      <label className="vp-field">
        <span>Nombre del canal</span>
        <input value={cfg.channels[key]?.name ?? ''} placeholder="p. ej. Micro del presentador" onChange={(e) => set((c) => setChannelInfo(c, key, { name: e.target.value }))} />
      </label>
      <label className="vp-field">
        <span>Nota</span>
        <textarea rows={2} value={cfg.channels[key]?.note ?? ''} placeholder="Micro, posición, cable…" onChange={(e) => set((c) => setChannelInfo(c, key, { note: e.target.value }))} />
      </label>
      <div className="vp-row vp-if-knobs">
        <Knob label="Ganancia" value={cfg.inputGainDb} min={GAIN_MIN} max={GAIN_MAX} step={0.5} unit="dB" def={0} center={0} onChange={(inputGainDb) => set((c) => ({ ...c, inputGainDb }))} />
        <Knob label="Salida" value={cfg.outputGainDb} min={-24} max={24} step={0.5} unit="dB" def={0} center={0} onChange={(outputGainDb) => set((c) => ({ ...c, outputGainDb }))} />
        <button className={`vp-btn vp-small ${cfg.phaseInvert ? 'on' : ''}`} onClick={() => set((c) => ({ ...c, phaseInvert: !c.phaseInvert }))} title="Invertir fase (Ø)">
          Ø
        </button>
      </div>
      {advice && <p className={`vp-if-advice ${advice.status}`}>{advice.message}</p>}
      <div>
        <small className="vp-dim">Procesamiento de este canal</small>
        <div className="vp-if-chips">
          {summary.length ? (
            summary.map((s) => (
              <span key={s} className="vp-if-chip">
                {s}
              </span>
            ))
          ) : (
            <span className="vp-dim">Sin procesar</span>
          )}
        </div>
      </div>
      <div className="vp-row">
        <button className="vp-btn primary" onClick={onOpenProcessor}>
          Editar en el procesador
        </button>
        {!running && (
          <button className="vp-btn" onClick={() => void processorEngine.start(cfg)}>
            <Icon name="power" size={15} />
            Encender procesador
          </button>
        )}
      </div>
      {others.length > 0 && (
        <label className="vp-field">
          <span>Copiar ajustes de otro canal</span>
          <select value="" onChange={(e) => e.target.value && set((c) => copyChannel(c, e.target.value, key))}>
            <option value="">Elegir canal…</option>
            {others.map((k) => (
              <option key={k} value={k}>
                {labelOf(k)}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="vp-row">
        <button className="vp-btn ghost" onClick={() => confirm('¿Dejar este canal sin procesar? El nombre y la nota se conservan.') && set((c) => resetChannel(c, key))}>
          <Icon name="reset" size={14} />
          Restablecer canal
        </button>
        {others.length > 0 && (
          <select value="" onChange={(e) => e.target.value && confirm('¿Olvidar los ajustes guardados de ese canal?') && set((c) => forgetChannel(c, e.target.value))}>
            <option value="">Olvidar otro canal…</option>
            {others.map((k) => (
              <option key={k} value={k}>
                {labelOf(k)}
              </option>
            ))}
          </select>
        )}
      </div>
      {(cfg.channels[key]?.updatedAt ?? 0) > 0 && (
        <small className="vp-dim">
          Guardado por última vez: <span className="vp-mono">{new Date(cfg.channels[key].updatedAt).toLocaleString()}</span>
        </small>
      )}
    </aside>
  )
}
