import { useEffect, useRef, useState } from 'react'
import { inputScanner, type ScanDevice, type ScanState } from '../../core/audio/InputScanner'
import { multiProcessor } from '../../core/audio/MultiProcessor'
import { processorEngine, type ProcessorLevels, type ProcessorStatus } from '../../core/audio/ProcessorEngine'
import { gainAdvice } from '../../core/mixer/mixer'
import {
  ActivityTracker,
  chainSummary,
  channelKey,
  channelView,
  copyChannel,
  forgetChannel,
  liveChannels,
  loadedOutput,
  mainConfig,
  parseChannelKey,
  resetChannel,
  setChannelInfo,
  switchChannel,
  type Activity,
  type ChannelInput
} from '../../core/processor/channels'
import { GAIN_MAX, GAIN_MIN, type ProcessorConfig } from '../../core/processor/processor'
import { useStore } from '../store'
import { Icon, Knob, Switch, useFrame } from './controls'
import { useProcessorState } from './ProcessorView'
import './processor.css'
import './interfaces.css'

// Every connected input at once, channel by channel. Clicking a channel loads it in the
// processor: the channel you were editing is stored as it was, the new one comes back with
// its own settings. One channel is worked on at a time; the others keep theirs, and the ones
// marked "en paralelo" keep being processed meanwhile, each to its own output.

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

function useOutputs(): MediaDeviceInfo[] {
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    const load = (): void => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setOutputs(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'communications' && x.deviceId !== 'default')))
        .catch(() => setOutputs([]))
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])
  return outputs
}

function outputName(outputs: MediaDeviceInfo[], id: string | null): string {
  if (!id) return 'Predeterminada del sistema'
  return outputs.find((o) => o.deviceId === id)?.label || 'Salida no conectada'
}

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
  const outputs = useOutputs()
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
          <span title="Canales que se procesan a la vez (el del procesador y los marcados en paralelo)">
            <small>En paralelo</small>
            <b>{liveChannels(cfg).length + 1}</b>
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
          <ParallelRack cfg={cfg} set={set} scan={scan} outputs={outputs} running={proc.status === 'on'} onOpenProcessor={onOpenProcessor} />
          {!scan.running && scan.devices.length === 0 && <section className="vp-panel vp-if-empty">Buscando interfaces…</section>}
          {scan.running && scan.devices.length === 0 && <section className="vp-panel vp-if-empty">No hay entradas de audio conectadas.</section>}
          {scan.devices.map((d) => (
            <DeviceCard key={d.deviceId} device={d} cfg={cfg} loadedKey={loadedKey} onLoad={load} />
          ))}
        </div>
        <ChannelDetail cfg={cfg} set={set} scan={scan} outputs={outputs} running={proc.status === 'on'} onOpenProcessor={onOpenProcessor} />
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
    <button className={`vp-if-tile ${loaded ? 'loaded' : ''} ${act.signal ? 'signal' : ''} ${setup?.live ? 'live' : ''}`} onClick={onClick} title={summary || 'Sin ajustes guardados'}>
      <span className="vp-if-num">{index + 1}</span>
      <span className={`vp-if-led ${act.clip ? 'clip' : act.signal ? 'on' : ''}`} />
      <b>{name || `Canal ${index + 1}`}</b>
      <div className="vp-if-meter">
        <i style={{ clipPath: `inset(0 ${100 - pct(peak)}% 0 0)` }} />
        <em style={{ width: `${pct(rms)}%` }} />
        <s style={{ left: `${pct(act.holdDb)}%` }} />
      </div>
      <small className="vp-mono">{act.holdDb <= -99 ? '—' : `${act.holdDb.toFixed(1)} dBFS`}</small>
      <small className="vp-if-badge">{loaded ? 'En el procesador' : setup?.live ? 'En paralelo' : setup ? 'Ajustado' : ''}</small>
    </button>
  )
}

function ChannelDetail({ cfg, set, scan, outputs, running, onOpenProcessor }: { cfg: ProcessorConfig; set: SetFn; scan: ScanState; outputs: MediaDeviceInfo[]; running: boolean; onOpenProcessor: () => void }): JSX.Element {
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
      <div className="vp-if-route">
        <div className="vp-row">
          <Switch
            on={cfg.channels[key]?.live ?? false}
            onChange={(live) => set((c) => setChannelInfo(c, key, { live }))}
            labels={['EN PARALELO', 'SOLO AL EDITAR']}
            title="Seguir procesando este canal mientras editas otro"
          />
          <small className="vp-dim">{cfg.channels[key]?.live ? 'Se sigue procesando aunque cargues otro canal.' : 'Solo suena mientras está cargado en el procesador.'}</small>
        </div>
        <label className="vp-field">
          <span>Salida del canal</span>
          <select
            value={cfg.channels[key]?.outputId ?? '__main'}
            onChange={(e) => set((c) => setChannelInfo(c, key, { outputId: e.target.value === '__main' ? null : e.target.value }))}
            title="Cada canal puede ir a su propia salida (p. ej. VoiceMeeter Input y VoiceMeeter AUX Input)"
          >
            <option value="__main">{`La del procesador · ${outputName(outputs, cfg.output.deviceId)}`}</option>
            <option value="">Predeterminada del sistema</option>
            {outputs.map((o, i) => (
              <option key={o.deviceId} value={o.deviceId}>
                {o.label || `Salida ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>
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
          <button className="vp-btn" onClick={() => void processorEngine.start(mainConfig(cfg))}>
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

// ---- Parallel processing: the loaded channel plus every channel marked live

const STATE_TEXT: Record<ProcessorStatus, string> = { off: 'Apagado', starting: 'Arrancando', on: 'Procesando', error: 'Error' }

interface RackRow {
  key: string
  status: ProcessorStatus
  error?: string
  levels: ProcessorLevels | null
  output: string | null
  loaded: boolean
}

function ParallelRack({ cfg, set, scan, outputs, running, onOpenProcessor }: { cfg: ProcessorConfig; set: SetFn; scan: ScanState; outputs: MediaDeviceInfo[]; running: boolean; onOpenProcessor: () => void }): JSX.Element | null {
  useFrame(20)
  const [, bump] = useState(0)
  useEffect(() => multiProcessor.onChange(() => bump((n) => n + 1)), [])
  const live = liveChannels(cfg)
  if (!live.length) return null
  const loadedKey = channelKey(cfg.input)
  const label = (key: string): [string, string] => {
    const i = parseChannelKey(key)
    const d = scan.devices.find((x) => x.deviceId === i.deviceId)
    const ch = i.channel < 0 ? 'Mezcla' : `Canal ${i.channel + 1}`
    const where = d?.label ?? (i.deviceId ? 'Interfaz no conectada' : 'Entrada predeterminada')
    const name = cfg.channels[key]?.name
    return name ? [name, `${ch} · ${where}`] : [ch, where]
  }
  const rows: RackRow[] = [
    { key: loadedKey, status: processorEngine.state.status, error: processorEngine.state.error, levels: processorEngine.levels(), output: loadedOutput(cfg), loaded: true },
    ...live.map((key) => {
      const p = multiProcessor.channel(key)
      return { key, status: p?.state.status ?? 'off', error: p?.state.error, levels: p?.levels ?? null, output: cfg.channels[key].outputId ?? cfg.output.deviceId, loaded: false }
    })
  ]
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  const meter = (peak: number, rms: number): JSX.Element => (
    <div className="vp-if-meter">
      <i style={{ clipPath: `inset(0 ${100 - pct(peak)}% 0 0)` }} />
      <em style={{ width: `${pct(rms)}%` }} />
    </div>
  )
  return (
    <section className="vp-panel vp-if-rack">
      <header className="vp-module-head">
        <b>Procesamiento en paralelo</b>
        <span className="vp-dim">Cada canal con sus ajustes y su salida · se encienden y apagan con el procesador</span>
        <span className="vp-grow" />
        {!running && (
          <button className="vp-btn vp-small" onClick={() => void processorEngine.start(mainConfig(cfg))}>
            <Icon name="power" size={14} />
            Encender todos
          </button>
        )}
      </header>
      <table className="vp-if-rack-table">
        <thead>
          <tr>
            <th>Canal</th>
            <th>Salida</th>
            <th>Entrada</th>
            <th>Procesado</th>
            <th title="Reducción de ganancia de compresores y limitador">Reducción</th>
            <th>Estado</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const [name, sub] = label(r.key)
            const l = r.levels
            const gr = l ? Math.min(0, l.comp1Gr + l.comp2Gr + l.limGr) : 0
            return (
              <tr key={r.key} className={r.loaded ? 'loaded' : ''}>
                <td>
                  <b>{name}</b>
                  <small className="vp-dim">{sub}</small>
                </td>
                <td className="vp-if-rack-out" title={outputName(outputs, r.output)}>
                  {outputName(outputs, r.output)}
                </td>
                <td>{meter(l?.inPeak ?? -100, l?.inRms ?? -100)}</td>
                <td>{meter(l?.outPeak ?? -100, l?.outRms ?? -100)}</td>
                <td className="vp-mono">{l ? `${gr.toFixed(1)} dB` : '—'}</td>
                <td>
                  <span className={`vp-if-status ${r.status === 'on' ? 'ok' : r.status === 'error' ? 'error' : 'missing'}`} title={r.error}>
                    {STATE_TEXT[r.status]}
                  </span>
                </td>
                <td className="vp-if-rack-actions">
                  {r.loaded ? (
                    <button className="vp-btn vp-small" onClick={onOpenProcessor} title="Este es el canal cargado en el procesador">
                      Editar
                    </button>
                  ) : (
                    <>
                      <button className="vp-btn vp-small" onClick={() => set((c) => switchChannel(c, parseChannelKey(r.key)))} title="Cargarlo en el procesador para editarlo (sigue sonando)">
                        Cargar
                      </button>
                      <button className="vp-btn vp-small ghost" onClick={() => set((c) => setChannelInfo(c, r.key, { live: false }))} title="Dejar de procesarlo en paralelo">
                        <Icon name="close" size={12} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
