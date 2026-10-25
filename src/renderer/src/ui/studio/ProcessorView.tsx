import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { processorEngine, PROCESSOR_FFT, type ProcessorLevels, type ProcessorState } from '../../core/audio/ProcessorEngine'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import { autoTrim, logFreqs } from '../../core/mixer/mixer'
import { autoMakeupDb, saturate, type CompParams } from '../../core/processor/dynamics'
import type { NoiseResolution } from '../../core/processor/noise'
import {
  applyChain,
  autoSetup,
  BAND_TYPES,
  band,
  buildPreset,
  defaultBands,
  defaultProcessor,
  eqCurve,
  GAIN_MAX,
  GAIN_MIN,
  hasGain,
  hasQ,
  hasSlope,
  MAX_BANDS,
  MICS,
  nodeBiquad,
  parsePreset,
  processingLatencyMs,
  processorWarnings,
  saveUserPreset,
  serializePreset,
  USES,
  VOICE_REGIONS,
  type AutoSetupResult,
  type BandType,
  type ParamBand,
  type ProcessorConfig,
  type VoiceMeasurement
} from '../../core/processor/processor'
import { compressorCurve, responseDb } from '../../core/studio/dsp'
import { openTextFile, saveFile } from '../storage'
import { useStore } from '../store'
import { Icon, Knob, Switch, useFrame, useHold, VMeter } from './controls'
import { fitCanvas, Segmented } from './widgets'
import './processor.css'

// Mic processor: one microphone → full voice chain → VoiceMeeter (or any output).
// Shared by the studio tab and the standalone "Gritómetro Procesador" edition.

export function useProcessorState(): ProcessorState {
  const [s, set] = useState(processorEngine.state)
  useEffect(() => processorEngine.onState(set), [])
  return s
}

type Patch = Partial<ProcessorConfig> | ((c: ProcessorConfig) => ProcessorConfig)
type SetFn = (p: Patch) => void

function useProcessor(): [ProcessorConfig, SetFn] {
  const { data, update } = useStore()
  return [data.processor, (p) => update('processor', (c) => (typeof p === 'function' ? p(c) : { ...c, ...p }))]
}

/** Live levels (null when off), re-read on every frame of the caller */
function useLevels(fps = 30): ProcessorLevels | null {
  useFrame(fps)
  return processorEngine.levels()
}

const isVirtual = (label: string): boolean => /voicemeeter|vb-audio|cable|virtual|vaio/i.test(label)

const COLORS = {
  noise: '#4dd6c9',
  gate: '#5ee08a',
  eq: '#3fb6ff',
  deesser: '#b48cff',
  comp1: '#ffb020',
  comp2: '#ff9a5a',
  saturation: '#ff6b8b',
  limiter: '#ff4d5e'
}

type ModuleId = keyof typeof COLORS
type GraphTab = 'eq' | 'dynamics' | 'noise'

export function ProcessorView(): JSX.Element {
  const [cfg, set] = useProcessor()
  const state = useProcessorState()
  const [inputs, setInputs] = useState<InputDevice[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [msg, setMsg] = useState('')
  const [assistant, setAssistant] = useState(false)
  const [graph, setGraph] = useState<GraphTab>('eq')
  const [selBand, setSelBand] = useState(0)
  const on = state.status === 'on'

  useEffect(() => {
    const load = (): void => {
      listInputs().then(setInputs).catch(() => setInputs([]))
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setOutputs(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'communications' && x.deviceId !== 'default')))
        .catch(() => setOutputs([]))
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])

  // B toggles the bypass (A/B against the raw mic)
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const setRef = useRef(set)
  setRef.current = set
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || e.ctrlKey || e.altKey) return
      if (e.key === 'b' || e.key === 'B') setRef.current({ bypass: !cfgRef.current.bypass })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A finished noise capture becomes the stored profile
  useEffect(
    () =>
      processorEngine.onNoiseProfile((profile) => {
        setRef.current((c) => ({ ...c, noise: { ...c.noise, mode: 'learned', profile: profile.map((v) => Number(v.toPrecision(4))) } }))
        setMsg('Perfil de ruido aprendido.')
      }),
    []
  )

  const outputLabel = cfg.output.deviceId ? (outputs.find((o) => o.deviceId === cfg.output.deviceId)?.label ?? null) : null
  const monitorLabel = cfg.monitor.deviceId ? (outputs.find((o) => o.deviceId === cfg.monitor.deviceId)?.label ?? null) : null
  const warnings = processorWarnings(cfg, outputLabel, monitorLabel)

  const power = (): void => {
    if (state.status === 'on' || state.status === 'starting') processorEngine.stop()
    else void processorEngine.start(cfg)
  }

  const focusModule = (id: ModuleId): void => {
    if (id === 'eq') setGraph('eq')
    if (id === 'noise') setGraph('noise')
    document.getElementById(`vp-mod-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const statusText = state.status === 'on' ? 'En línea' : state.status === 'starting' ? 'Arrancando' : state.status === 'error' ? 'Error' : 'Apagado'

  return (
    <div className={`vp ${cfg.bypass ? 'bypassed' : ''}`}>
      <header className="vp-head">
        <div className="vp-title">
          <b>Procesador vocal</b>
          <span>Reducción de ruido · puerta · EQ paramétrico · de-esser · compresión · saturación · limitador</span>
        </div>
        <span className="vp-grow" />
        <div className={`vp-status ${state.status}`}>
          <i />
          {statusText}
        </div>
        <div className="vp-readout-strip">
          <span>
            <small>Muestreo</small>
            <b>{on ? `${((state.sampleRate ?? 48000) / 1000).toFixed(1)} kHz` : '—'}</b>
          </span>
          <span title="Latencia estimada: dispositivos + procesamiento">
            <small>Latencia</small>
            <b>{on ? `${state.latencyMs} ms` : `${processingLatencyMs(cfg, cfg.sampleRate ?? 48000).toFixed(1)} ms`}</b>
          </span>
        </div>
        <button className={`vp-btn vp-ab ${cfg.bypass ? 'active' : ''}`} onClick={() => set({ bypass: !cfg.bypass })} title="Escuchar el micrófono sin procesar (tecla B)">
          {cfg.bypass ? 'BYPASS' : 'A/B'}
        </button>
        <button className={`vp-btn vp-power ${on ? 'on' : ''}`} onClick={power} title={on ? 'Apagar el procesador' : 'Encender el procesador'}>
          <Icon name="power" size={18} />
          {state.status === 'starting' ? 'Arrancando…' : on ? 'Apagar' : 'Encender'}
        </button>
      </header>
      {state.status === 'error' && <p className="vp-error">{state.error}</p>}

      <IoPanel cfg={cfg} set={set} inputs={inputs} outputs={outputs} channels={on ? (state.channels ?? 1) : 2} />
      <PresetBar cfg={cfg} set={set} on={on} setMsg={setMsg} onAssistant={() => setAssistant(true)} />
      {msg && <p className="vp-msg">{msg}</p>}
      {warnings.length > 0 && (
        <ul className="vp-warnings">
          {warnings.map((w) => (
            <li key={w.message} className={w.level}>
              <Icon name="warning" size={14} />
              {w.message}
            </li>
          ))}
        </ul>
      )}

      <div className="vp-main">
        <InputColumn cfg={cfg} set={set} on={on} />
        <div className="vp-center">
          <SignalFlow cfg={cfg} set={set} on={on} onSelect={focusModule} />
          <section className="vp-panel vp-graph">
            <header className="vp-graph-head">
              <Segmented<GraphTab>
                value={graph}
                onChange={setGraph}
                options={[
                  ['eq', 'Ecualizador'],
                  ['dynamics', 'Dinámica'],
                  ['noise', 'Ruido']
                ]}
              />
              <span className="vp-grow" />
              {graph === 'eq' && <EqToolbar cfg={cfg} set={set} onAdd={() => setSelBand(Math.min(MAX_BANDS - 1, cfg.eq.bands.length))} />}
            </header>
            {graph === 'eq' && <EqGraph cfg={cfg} set={set} on={on} sel={selBand} setSel={setSelBand} sampleRate={state.sampleRate ?? cfg.sampleRate ?? 48000} />}
            {graph === 'dynamics' && <DynamicsHistory on={on} />}
            {graph === 'noise' && <NoiseGraph on={on} cfg={cfg} />}
          </section>
        </div>
        <OutputColumn cfg={cfg} set={set} on={on} />
      </div>

      <EqBands cfg={cfg} set={set} sel={selBand} setSel={setSelBand} />

      <div className="vp-modules">
        <NoiseModule cfg={cfg} set={set} on={on} setMsg={setMsg} />
        <GateModule cfg={cfg} set={set} on={on} />
        <DeEsserModule cfg={cfg} set={set} />
        <CompModule title="Compresor 1 · picos" which="comp1" cfg={cfg} set={set} />
        <CompModule title="Compresor 2 · nivelador" which="comp2" cfg={cfg} set={set} />
        <SaturationModule cfg={cfg} set={set} />
        <LimiterModule cfg={cfg} set={set} />
      </div>

      {assistant && (
        <Assistant
          cfg={cfg}
          onClose={() => setAssistant(false)}
          onApply={(r) => {
            set(r.patch)
            setAssistant(false)
            setMsg('Asistente aplicado. Escucha con B (bypass) para comparar.')
          }}
        />
      )}
    </div>
  )
}

// ---- I/O and presets

function IoPanel({ cfg, set, inputs, outputs, channels }: { cfg: ProcessorConfig; set: SetFn; inputs: InputDevice[]; outputs: MediaDeviceInfo[]; channels: number }): JSX.Element {
  const [guide, setGuide] = useState(false)
  const vm = outputs.filter((o) => isVirtual(o.label))
  return (
    <section className="vp-panel vp-io">
      <div className="vp-io-group">
        <h3>
          <Icon name="mic" size={14} />
          Entrada
        </h3>
        <label className="vp-field">
          <span>Micrófono</span>
          <select value={cfg.input.deviceId ?? ''} onChange={(e) => set({ input: { ...cfg.input, deviceId: e.target.value || null } })}>
            <option value="">Predeterminado del sistema</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
                {d.virtual ? ' (virtual)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="vp-field vp-narrow">
          <span>Canal</span>
          <select value={cfg.input.channel} onChange={(e) => set({ input: { ...cfg.input, channel: Number(e.target.value) } })}>
            <option value={-1}>Mezcla de todos</option>
            {Array.from({ length: Math.max(channels, cfg.input.channel + 1, 1) }, (_, i) => (
              <option key={i} value={i}>
                Canal {i + 1}
              </option>
            ))}
          </select>
        </label>
        <label className="vp-field vp-narrow">
          <span>Frecuencia de muestreo</span>
          <select value={cfg.sampleRate ?? 0} onChange={(e) => set({ sampleRate: Number(e.target.value) || null })}>
            <option value={0}>Del dispositivo</option>
            <option value={44100}>44.1 kHz</option>
            <option value={48000}>48 kHz</option>
            <option value={96000}>96 kHz</option>
          </select>
        </label>
      </div>
      <div className="vp-io-group">
        <h3>
          <Icon name="speaker" size={14} />
          Salida
        </h3>
        <label className="vp-field">
          <span>Dispositivo (VoiceMeeter Input recomendado)</span>
          <select value={cfg.output.deviceId ?? ''} onChange={(e) => set({ output: { ...cfg.output, deviceId: e.target.value || null } })}>
            <option value="">Predeterminada del sistema</option>
            {outputs.map((o, i) => (
              <option key={o.deviceId} value={o.deviceId}>
                {o.label || `Salida ${i + 1}`}
                {isVirtual(o.label) ? ' (virtual)' : ''}
              </option>
            ))}
          </select>
        </label>
        <Switch on={!cfg.output.mute} onChange={(v) => set({ output: { ...cfg.output, mute: !v } })} labels={['SALIDA', 'MUTE']} title="Silenciar salida" />
        {vm.slice(0, 3).map((o) => (
          <button key={o.deviceId} className={`vp-btn vp-chip ${cfg.output.deviceId === o.deviceId ? 'on' : ''}`} onClick={() => set({ output: { ...cfg.output, deviceId: o.deviceId } })} title={o.label}>
            {shortVm(o.label)}
          </button>
        ))}
      </div>
      <div className="vp-io-group">
        <h3>
          <Icon name="headphones" size={14} />
          Escucha
        </h3>
        <Switch on={cfg.monitor.on} onChange={(v) => set({ monitor: { ...cfg.monitor, on: v } })} title="Escucha del procesado por auriculares" />
        <label className="vp-field">
          <span>Auriculares</span>
          <select value={cfg.monitor.deviceId ?? ''} onChange={(e) => set({ monitor: { ...cfg.monitor, deviceId: e.target.value || null } })}>
            <option value="">Predeterminada del sistema</option>
            {outputs.map((o, i) => (
              <option key={o.deviceId} value={o.deviceId}>
                {o.label || `Salida ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <Knob label="Nivel" value={cfg.monitor.levelDb} min={-40} max={6} step={0.5} unit="dB" def={-6} size={36} onChange={(levelDb) => set({ monitor: { ...cfg.monitor, levelDb } })} />
        <button className="vp-btn ghost" onClick={() => setGuide((g) => !g)} title="Cómo conectarlo a VoiceMeeter">
          <Icon name="help" size={15} />
          Guía VoiceMeeter
        </button>
      </div>
      {guide && <VoiceMeeterGuide />}
    </section>
  )
}

function shortVm(label: string): string {
  const m = /voicemeeter\s+(aux\s+input|vaio3\s+input|input)/i.exec(label)
  if (m) return m[0].replace(/voicemeeter\s+/i, 'VM ')
  return label.replace(/\(.*\)/, '').trim().slice(0, 24)
}

function VoiceMeeterGuide(): JSX.Element {
  return (
    <div className="vp-guide">
      <ol>
        <li>
          <b>Micrófono:</b> elige aquí tu micrófono (o su canal de la interfaz). En VoiceMeeter no lo envíes a B1, o sonará doble y sin procesar.
        </li>
        <li>
          <b>Salida:</b> elige «VoiceMeeter Input» (en Banana/Potato también sirven «AUX Input» o «VAIO3 Input»).
        </li>
        <li>
          <b>En VoiceMeeter:</b> la tira virtual «VoiceMeeter VAIO» (o AUX) recibe tu voz procesada. Actívale B1 (o B2) y A1 si quieres oírte.
        </li>
        <li>
          <b>En Discord, OBS, Zoom…:</b> elige como micrófono «VoiceMeeter Output» (B1) o «VoiceMeeter Aux Output» (B2).
        </li>
        <li>
          <b>Frecuencia:</b> usa 48 kHz aquí y en VoiceMeeter (Menu → System Settings) para no remuestrear.
        </li>
      </ol>
      <p>Alternativa: si el micro ya entra en VoiceMeeter, toma aquí como entrada «VoiceMeeter Out B2», procésalo y devuélvelo por «VoiceMeeter AUX Input».</p>
    </div>
  )
}

function PresetBar({ cfg, set, on, setMsg, onAssistant }: { cfg: ProcessorConfig; set: SetFn; on: boolean; setMsg: (m: string) => void; onAssistant: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const apply = (): void => {
    set((c) => applyChain(c, buildPreset(c.useId, c.micId)))
    const u = USES.find((x) => x.id === cfg.useId)
    const m = MICS.find((x) => x.id === cfg.micId)
    setMsg(`Preset aplicado: ${u?.name} · ${m?.name}`)
  }
  const exportPreset = async (): Promise<void> => {
    const n = name.trim() || 'procesador'
    const path = await saveFile(`${n}.json`, serializePreset(n, cfg))
    if (path) setMsg(`Preset guardado en ${path}`)
  }
  const importPreset = async (): Promise<void> => {
    const text = await openTextFile(['json'])
    if (!text) return
    try {
      const p = parsePreset(text)
      set((c) => saveUserPreset(applyChain(c, p.chain), p.name))
      setMsg(`Preset «${p.name}» cargado.`)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <section className="vp-panel vp-presets">
      <label className="vp-field">
        <span>Uso</span>
        <select value={cfg.useId} onChange={(e) => set({ useId: e.target.value })} title={USES.find((u) => u.id === cfg.useId)?.hint}>
          {USES.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      <label className="vp-field">
        <span>Tipo de micrófono</span>
        <select value={cfg.micId} onChange={(e) => set({ micId: e.target.value })} title={MICS.find((m) => m.id === cfg.micId)?.hint}>
          {MICS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <button className="vp-btn primary" onClick={apply} title="Carga una cadena completa pensada para ese uso y ese micrófono">
        Aplicar preset
      </button>
      <button className="vp-btn" onClick={onAssistant} disabled={!on} title={on ? 'Mide tu voz y el ruido y ajusta ganancia, puerta, compresores y EQ' : 'Enciende el procesador primero'}>
        <Icon name="wand" size={15} />
        Asistente automático
      </button>
      <span className="vp-grow" />
      <label className="vp-field">
        <span>Mis presets</span>
        <select
          value=""
          onChange={(e) => {
            const p = cfg.userPresets.find((x) => x.id === e.target.value)
            if (p) {
              set((c) => applyChain(c, p.apply))
              setMsg(`Preset «${p.name}» aplicado.`)
            }
          }}
        >
          <option value="">{cfg.userPresets.length ? 'Cargar…' : 'Sin presets guardados'}</option>
          {cfg.userPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <input className="vp-name" placeholder="Nombre del preset" value={name} onChange={(e) => setName(e.target.value)} />
      <button
        className="vp-btn"
        onClick={() => {
          set((c) => saveUserPreset(c, name))
          setMsg('Preset guardado.')
          setName('')
        }}
        title="Guardar la cadena actual como preset"
      >
        <Icon name="save" size={15} />
        Guardar
      </button>
      {cfg.userPresets.length > 0 && (
        <select value="" onChange={(e) => e.target.value && confirm('¿Borrar ese preset?') && set((c) => ({ ...c, userPresets: c.userPresets.filter((p) => p.id !== e.target.value) }))}>
          <option value="">Borrar…</option>
          {cfg.userPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <button className="vp-btn ghost" onClick={exportPreset} title="Exportar la cadena actual a un archivo">
        <Icon name="download" size={15} />
        Exportar
      </button>
      <button className="vp-btn ghost" onClick={importPreset} title="Importar un preset desde un archivo">
        <Icon name="upload" size={15} />
        Importar
      </button>
      <button
        className="vp-btn ghost"
        onClick={() =>
          confirm('¿Restablecer todo el procesamiento (EQ, dinámica y ganancias)?') &&
          set((c) => ({ ...defaultProcessor(), input: c.input, output: c.output, monitor: c.monitor, sampleRate: c.sampleRate, userPresets: c.userPresets, useId: c.useId, micId: c.micId }))
        }
        title="Restablecer"
      >
        <Icon name="reset" size={15} />
        Restablecer
      </button>
    </section>
  )
}

// ---- Side columns: meters, gains, loudness

/** Measures a level for a few seconds and hands back the loudest peak or the average RMS */
function useMeasure(): { running: number; run: (seconds: number, kind: 'peak' | 'rms', done: (db: number) => void) => void } {
  const [running, setRunning] = useState(0)
  const run = (seconds: number, kind: 'peak' | 'rms', done: (db: number) => void): void => {
    let max = -100
    let sum = 0
    let n = 0
    const t0 = performance.now()
    setRunning(seconds)
    const t = setInterval(() => {
      const l = processorEngine.levels()
      if (l) {
        max = Math.max(max, l.inPeak)
        sum += Math.pow(10, l.inRms / 10)
        n++
      }
      const left = seconds - (performance.now() - t0) / 1000
      setRunning(Math.max(0, Math.ceil(left)))
      if (left <= 0) {
        clearInterval(t)
        setRunning(0)
        done(kind === 'peak' ? max : n ? 10 * Math.log10(sum / n) : -100)
      }
    }, 50)
  }
  return { running, run }
}

function InputColumn({ cfg, set, on }: { cfg: ProcessorConfig; set: SetFn; on: boolean }): JSX.Element {
  const l = useLevels()
  const hold = useHold(l?.inPeak ?? -100)
  const clip = useHold(l && l.inPeak > -0.5 ? 1 : 0, 2000) > 0
  const m = useMeasure()
  return (
    <aside className="vp-panel vp-side">
      <h3>Entrada</h3>
      <VMeter label="IN" peak={l?.inPeak ?? -100} rms={l?.inRms ?? -100} hold={hold} clip={clip} />
      <div className="vp-side-value">
        <small>Pico</small>
        <b>{hold <= -99 ? '—' : hold.toFixed(1)}</b>
      </div>
      <Knob label="Ganancia" value={cfg.inputGainDb} min={GAIN_MIN} max={GAIN_MAX} step={0.5} unit="dB" def={0} center={0} onChange={(inputGainDb) => set({ inputGainDb })} />
      <div className="vp-row vp-center-row">
        <button className={`vp-btn vp-small ${cfg.phaseInvert ? 'on' : ''}`} onClick={() => set({ phaseInvert: !cfg.phaseInvert })} title="Invertir fase (Ø)">
          Ø
        </button>
        <button
          className="vp-btn vp-small"
          disabled={!on || m.running > 0}
          title="Habla o grita como lo harás de verdad durante 5 s: los picos quedarán en −12 dBFS"
          onClick={() =>
            m.run(5, 'peak', (peak) => {
              const t = autoTrim(cfg.inputGainDb, peak)
              if (t !== null) set({ inputGainDb: Math.max(GAIN_MIN, Math.min(GAIN_MAX, t)) })
            })
          }
        >
          {m.running ? `Habla… ${m.running}` : 'Auto'}
        </button>
      </div>
    </aside>
  )
}

function OutputColumn({ cfg, set, on }: { cfg: ProcessorConfig; set: SetFn; on: boolean }): JSX.Element {
  const l = useLevels()
  const hold = useHold(l?.outPeak ?? -100)
  const clip = useHold(l && l.outPeak > -0.3 ? 1 : 0, 2000) > 0
  const loud = processorEngine.loudness()
  const lufs = (v: number | undefined): string => (v === undefined || v <= -69 ? '—' : v.toFixed(1))
  return (
    <aside className="vp-panel vp-side">
      <h3>Salida</h3>
      <VMeter label="OUT" peak={l?.outPeak ?? -100} rms={l?.outRms ?? -100} hold={hold} clip={clip} />
      <div className="vp-loudness">
        <span>
          <small>LUFS M</small>
          <b>{lufs(loud?.momentary)}</b>
        </span>
        <span>
          <small>LUFS S</small>
          <b>{lufs(loud?.shortTerm)}</b>
        </span>
        <span>
          <small>LUFS I</small>
          <b>{lufs(loud?.integrated)}</b>
        </span>
        <span>
          <small>LRA</small>
          <b>{loud && loud.lra > 0 ? loud.lra.toFixed(1) : '—'}</b>
        </span>
        <span className={loud && loud.truePeak > -1 ? 'hot' : ''}>
          <small>TP máx</small>
          <b>{loud && loud.truePeak > -99 ? loud.truePeak.toFixed(1) : '—'}</b>
        </span>
        <button className="vp-btn vp-small" disabled={!on} onClick={() => processorEngine.resetLoudness()} title="Reiniciar medición de loudness">
          <Icon name="reset" size={13} />
        </button>
      </div>
      <Knob label="Salida" value={cfg.outputGainDb} min={-24} max={24} step={0.5} unit="dB" def={0} center={0} onChange={(outputGainDb) => set({ outputGainDb })} />
    </aside>
  )
}

// ---- Signal flow with live gain reduction

function SignalFlow({ cfg, set, on, onSelect }: { cfg: ProcessorConfig; set: SetFn; on: boolean; onSelect: (id: ModuleId) => void }): JSX.Element {
  const l = useLevels(20)
  const gr = (v: number | undefined): string => (v === undefined || v > -0.1 ? '0.0' : v.toFixed(1))
  const block = (id: ModuleId, title: string, active: boolean, toggle: () => void, value: string, reduction: number): JSX.Element => (
    <div key={id} className={`vp-block ${active ? 'active' : ''}`} style={{ ['--mod' as string]: COLORS[id] }} onClick={() => onSelect(id)}>
      <button
        className={`vp-led ${active ? 'on' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        title="Activar / desactivar"
      />
      <b>{title}</b>
      <div className="vp-gr">
        <i style={{ transform: `scaleX(${Math.min(1, -reduction / 24)})` }} />
      </div>
      <span className="vp-mono">{value}</span>
    </div>
  )
  const eq = block('eq', 'EQ', cfg.eq.on, () => set({ eq: { ...cfg.eq, on: !cfg.eq.on } }), `${cfg.eq.bands.filter((b) => b.on).length} bandas`, 0)
  const dyn = [
    block('deesser', 'De-esser', cfg.deesser.on, () => set({ deesser: { ...cfg.deesser, on: !cfg.deesser.on } }), `${gr(l?.deessGr)} dB`, l?.deessGr ?? 0),
    block('comp1', 'Comp 1', cfg.comp1.on, () => set({ comp1: { ...cfg.comp1, on: !cfg.comp1.on } }), `${gr(l?.comp1Gr)} dB`, l?.comp1Gr ?? 0),
    block('comp2', 'Comp 2', cfg.comp2.on, () => set({ comp2: { ...cfg.comp2, on: !cfg.comp2.on } }), `${gr(l?.comp2Gr)} dB`, l?.comp2Gr ?? 0),
    block('saturation', 'Saturador', cfg.saturation.on, () => set({ saturation: { ...cfg.saturation, on: !cfg.saturation.on } }), cfg.saturation.on ? `${cfg.saturation.driveDb} dB` : '—', 0)
  ]
  const order = cfg.eqPosition === 'pre' ? [eq, ...dyn] : [...dyn, eq]
  return (
    <section className="vp-panel vp-flow">
      {block('noise', 'Ruido', cfg.noise.on, () => set({ noise: { ...cfg.noise, on: !cfg.noise.on } }), `${gr(l?.noiseGr)} dB`, l?.noiseGr ?? 0)}
      {block('gate', cfg.gate.mode === 'gate' ? 'Puerta' : 'Expansor', cfg.gate.on, () => set({ gate: { ...cfg.gate, on: !cfg.gate.on } }), on && cfg.gate.on ? (l?.gateOpen ? 'abierta' : 'cerrada') : '—', l?.gateDb ?? 0)}
      {order}
      {block('limiter', 'Limitador', cfg.limiter.on, () => set({ limiter: { ...cfg.limiter, on: !cfg.limiter.on } }), `${gr(l?.limGr)} dB`, l?.limGr ?? 0)}
    </section>
  )
}

// ---- Parametric EQ graph with live spectrum

const EQ_W = 1000
const EQ_H = 300
const EQ_RANGE = 18
const EQ_FREQS = logFreqs(300)
const xOfF = (f: number): number => (Math.log10(f / 20) / 3) * EQ_W
const fOfX = (x: number): number => 20 * Math.pow(1000, Math.max(0, Math.min(EQ_W, x)) / EQ_W)
const yOfDb = (db: number): number => EQ_H / 2 - (Math.max(-EQ_RANGE * 1.4, Math.min(EQ_RANGE * 1.4, db)) / EQ_RANGE) * (EQ_H / 2)
const dbOfY = (y: number): number => ((EQ_H / 2 - y) / (EQ_H / 2)) * EQ_RANGE
const BAND_COLORS = ['#ff6b8b', '#ffb020', '#ffe066', '#5ee08a', '#4dd6c9', '#3fb6ff', '#b48cff', '#ff9a5a']
const F_MARKS = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000]

type SpecMode = 'both' | 'out' | 'in' | 'off'

function EqToolbar({ cfg, set, onAdd }: { cfg: ProcessorConfig; set: SetFn; onAdd: () => void }): JSX.Element {
  const eq = cfg.eq
  return (
    <div className="vp-row">
      <Switch on={eq.on} onChange={(v) => set({ eq: { ...eq, on: v } })} title="Ecualizador activo" />
      <Segmented<ProcessorConfig['eqPosition']>
        value={cfg.eqPosition}
        onChange={(eqPosition) => set({ eqPosition })}
        options={[
          ['pre', 'EQ → Comp'],
          ['post', 'Comp → EQ']
        ]}
        title="Orden: ecualizar antes de comprimir (clásico) o después"
      />
      <button
        className="vp-btn"
        onClick={() => {
          if (eq.bands.length >= MAX_BANDS) return
          set((c) => ({ ...c, eq: { ...c.eq, bands: [...c.eq.bands, band('peaking', 1000, 0, 1)] } }))
          onAdd()
        }}
        disabled={eq.bands.length >= MAX_BANDS}
      >
        <Icon name="plus" size={14} />
        Banda
      </button>
      <button className="vp-btn ghost" onClick={() => set({ eq: { ...eq, bands: eq.bands.map((x) => ({ ...x, gainDb: 0 })) } })}>
        Ganancias a 0
      </button>
      <button className="vp-btn ghost" onClick={() => set({ eq: { ...eq, bands: defaultBands() } })}>
        Bandas por defecto
      </button>
    </div>
  )
}

function EqGraph({ cfg, set, on, sel, setSel, sampleRate }: { cfg: ProcessorConfig; set: SetFn; on: boolean; sel: number; setSel: (i: number) => void; sampleRate: number }): JSX.Element {
  const [spec, setSpec] = useState<SpecMode>('both')
  const [hold, setHold] = useState(true)
  const svg = useRef<SVGSVGElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const eq = cfg.eq
  const curve = useMemo(() => eqCurve(eq, EQ_FREQS, sampleRate), [eq, sampleRate])
  const selCurve = useMemo(() => (eq.bands[sel] ? eqCurve(eq, EQ_FREQS, sampleRate, sel) : null), [eq, sel, sampleRate])
  const setBand = (i: number, p: Partial<ParamBand>): void => set((c) => ({ ...c, eq: { ...c.eq, bands: c.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } }))

  useEffect(() => {
    const c = canvas.current
    if (!on || spec === 'off') {
      if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
      return
    }
    const bufIn = new Float32Array(PROCESSOR_FFT / 2)
    const bufOut = new Float32Array(PROCESSOR_FFT / 2)
    const cols = 360
    const peak = new Float32Array(cols + 1).fill(-140)
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const el = canvas.current
      if (!el) return
      const [w, h] = fitCanvas(el)
      const g = el.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const binHz = sampleRate / PROCESSOR_FFT
      const column = (buf: Float32Array, k: number): number => {
        const f0 = 20 * Math.pow(1000, k / cols)
        const f1 = 20 * Math.pow(1000, (k + 1) / cols)
        let m = -140
        for (let b = Math.max(1, Math.floor(f0 / binHz)); b <= Math.max(1, Math.ceil(f1 / binHz)) && b < buf.length; b++) if (buf[b] > m) m = buf[b]
        return m
      }
      // −100…−10 dBFS fills the height
      const yOf = (db: number): number => h - Math.max(0, Math.min(1, (db + 100) / 90)) * h
      const plot = (buf: Float32Array, fill: string, stroke: string, keepPeak: boolean): void => {
        g.beginPath()
        g.moveTo(0, h)
        for (let k = 0; k <= cols; k++) {
          const m = column(buf, k)
          if (keepPeak) peak[k] = Math.max(m, peak[k] - 0.35)
          g.lineTo((k / cols) * w, yOf(m))
        }
        g.lineTo(w, h)
        g.closePath()
        g.fillStyle = fill
        g.fill()
        g.strokeStyle = stroke
        g.lineWidth = 1
        g.stroke()
      }
      if ((spec === 'both' || spec === 'in') && processorEngine.spectrum('in', bufIn)) plot(bufIn, 'rgba(138,147,163,0.10)', 'rgba(138,147,163,0.40)', false)
      if ((spec === 'both' || spec === 'out') && processorEngine.spectrum('out', bufOut)) {
        plot(bufOut, 'rgba(63,182,255,0.14)', 'rgba(63,182,255,0.65)', true)
        if (hold) {
          g.beginPath()
          for (let k = 0; k <= cols; k++) g[k ? 'lineTo' : 'moveTo']((k / cols) * w, yOf(peak[k]))
          g.strokeStyle = 'rgba(255,224,102,0.55)'
          g.lineWidth = 1
          g.stroke()
        }
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [on, spec, sampleRate, hold])

  const pointer = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * EQ_W, y: ((e.clientY - r.top) / r.height) * EQ_H }
  }
  const path = (vals: number[]): string => vals.map((db, i) => `${i ? 'L' : 'M'}${xOfF(EQ_FREQS[i]).toFixed(1)},${yOfDb(db).toFixed(1)}`).join(' ')
  const b = eq.bands[sel]

  return (
    <>
      <div className="vp-graph-wrap">
        <canvas ref={canvas} className="vp-graph-canvas" />
        <svg
          ref={svg}
          className="vp-eq"
          viewBox={`0 0 ${EQ_W} ${EQ_H}`}
          preserveAspectRatio="none"
          onPointerMove={(e) => {
            if (drag.current === null) return
            const i = drag.current
            const { x, y } = pointer(e)
            const t = eq.bands[i]?.type
            const p: Partial<ParamBand> = { freq: Math.round(fOfX(x)) }
            if (t && hasGain(t)) p.gainDb = Math.round(Math.max(-EQ_RANGE, Math.min(EQ_RANGE, dbOfY(y))) * 2) / 2
            setBand(i, p)
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
          onDoubleClick={(e) => {
            if ((e.target as Element).closest('.handle') || eq.bands.length >= MAX_BANDS) return
            const { x, y } = pointer(e)
            set((c) => ({ ...c, eq: { ...c.eq, bands: [...c.eq.bands, band('peaking', Math.round(fOfX(x)), Math.round(Math.max(-EQ_RANGE, Math.min(EQ_RANGE, dbOfY(y))) * 2) / 2, 1)] } }))
            setSel(eq.bands.length)
          }}
          onWheel={(e) => {
            if (!b || !hasQ(b.type)) return
            setBand(sel, { q: Math.round(Math.max(0.1, Math.min(20, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) * 100) / 100 })
          }}
        >
          {F_MARKS.map((f) => (
            <g key={f}>
              <line x1={xOfF(f)} x2={xOfF(f)} y1={0} y2={EQ_H} className={f === 100 || f === 1000 || f === 10000 ? 'grid major' : 'grid'} />
              <text x={xOfF(f) + 3} y={EQ_H - 5}>
                {f >= 1000 ? `${f / 1000}k` : f}
              </text>
            </g>
          ))}
          {[-18, -12, -6, 0, 6, 12, 18].map((d) => (
            <g key={d}>
              <line x1={0} x2={EQ_W} y1={yOfDb(d)} y2={yOfDb(d)} className={d === 0 ? 'zero' : 'grid'} />
              <text x={4} y={yOfDb(d) - 3}>
                {d > 0 ? `+${d}` : d}
              </text>
            </g>
          ))}
          {selCurve && <path d={`${path(selCurve)} L${EQ_W},${EQ_H / 2} L0,${EQ_H / 2} Z`} className="sel-fill" style={{ fill: BAND_COLORS[sel % 8] }} />}
          <path d={path(curve)} className="curve" />
          {eq.bands.map((x, i) => {
            const cx = xOfF(Math.max(20, Math.min(20000, x.freq)))
            const cy = yOfDb(hasGain(x.type) && eq.on && x.on ? x.gainDb : 0)
            return (
              <g
                key={i}
                className={`handle ${sel === i ? 'sel' : ''} ${x.on ? '' : 'off'}`}
                style={{ ['--band' as string]: BAND_COLORS[i % 8] }}
                onPointerDown={(e) => {
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  drag.current = i
                  setSel(i)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setBand(i, { on: !x.on })
                }}
              >
                <circle cx={cx} cy={cy} r={10} />
                <text x={cx} y={cy + 4} textAnchor="middle">
                  {i + 1}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      <footer className="vp-graph-foot">
        <span>Arrastra los puntos · rueda = ancho (Q) · doble clic = nueva banda · clic derecho = activar/desactivar</span>
        <span className="vp-grow" />
        <span className="vp-legend in">Entrada</span>
        <span className="vp-legend out">Salida</span>
        {hold && <span className="vp-legend hold">Pico</span>}
        <Segmented<SpecMode>
          value={spec}
          onChange={setSpec}
          options={[
            ['both', 'Ambos'],
            ['out', 'Salida'],
            ['in', 'Entrada'],
            ['off', 'Sin analizador']
          ]}
          title="Espectro en vivo detrás de la curva"
        />
        <Switch on={hold} onChange={setHold} labels={['PICO', 'PICO']} title="Retención de picos del espectro de salida" />
      </footer>
    </>
  )
}

function EqBands({ cfg, set, sel, setSel }: { cfg: ProcessorConfig; set: SetFn; sel: number; setSel: (i: number) => void }): JSX.Element {
  const eq = cfg.eq
  const setBand = (i: number, p: Partial<ParamBand>): void => set((c) => ({ ...c, eq: { ...c.eq, bands: c.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } }))
  const remove = (i: number): void => {
    set((c) => ({ ...c, eq: { ...c.eq, bands: c.eq.bands.filter((_, j) => j !== i) } }))
    setSel(Math.max(0, sel >= i ? sel - 1 : sel))
  }
  return (
    <section className={`vp-panel vp-bands ${eq.on ? '' : 'off'}`}>
      {eq.bands.map((x, i) => (
        <div key={i} className={`vp-band ${sel === i ? 'sel' : ''} ${x.on ? '' : 'off'}`} style={{ ['--band' as string]: BAND_COLORS[i % 8] }} onClick={() => setSel(i)}>
          <header>
            <button
              className={`vp-led ${x.on ? 'on' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setBand(i, { on: !x.on })
              }}
              title="Activar banda"
            />
            <b>{i + 1}</b>
            <select value={x.type} onChange={(e) => setBand(i, { type: e.target.value as BandType })}>
              {BAND_TYPES.map(([t, label]) => (
                <option key={t} value={t}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="vp-x"
              onClick={(e) => {
                e.stopPropagation()
                remove(i)
              }}
              title="Quitar banda"
            >
              <Icon name="close" size={12} />
            </button>
          </header>
          <div className="vp-band-knobs">
            <Knob label="Frec." value={x.freq} min={20} max={20000} step={1} unit="Hz" log def={defaultBands()[i]?.freq ?? 1000} size={40} onChange={(freq) => setBand(i, { freq })} />
            <Knob label="Gan." value={x.gainDb} min={-24} max={24} step={0.5} unit="dB" def={0} center={0} size={40} disabled={!hasGain(x.type)} onChange={(gainDb) => setBand(i, { gainDb })} />
            <Knob label={hasSlope(x.type) ? 'Res.' : 'Q'} value={x.q} min={0.1} max={20} step={0.01} log def={hasSlope(x.type) ? 0.71 : 1} size={40} disabled={!hasQ(x.type)} onChange={(q) => setBand(i, { q })} />
          </div>
          {hasSlope(x.type) && (
            <select className="vp-slope" value={x.slope} onChange={(e) => setBand(i, { slope: Number(e.target.value) as ParamBand['slope'] })}>
              {[12, 24, 36, 48].map((s) => (
                <option key={s} value={s}>
                  {s} dB/oct
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
    </section>
  )
}

// ---- Dynamics history: input, output, gain reduction over the last seconds

const HISTORY = 360

function DynamicsHistory({ on }: { on: boolean }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const buf = Array.from({ length: HISTORY }, () => ({ inp: -100, out: -100, gr: 0, nr: 0, gate: true }))
    let head = 0
    let raf = 0
    let last = 0
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      const el = canvas.current
      if (!el) return
      if (now - last >= 1000 / 30) {
        last = now
        const l = processorEngine.levels()
        buf[head] = l
          ? { inp: l.inPeak, out: l.outPeak, gr: Math.min(0, l.comp1Gr + l.comp2Gr + l.limGr + l.deessGr), nr: l.noiseGr, gate: l.gateOpen || l.gateDb > -1 }
          : { inp: -100, out: -100, gr: 0, nr: 0, gate: true }
        head = (head + 1) % HISTORY
      }
      const [w, h] = fitCanvas(el)
      const g = el.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const dpr = devicePixelRatio
      const yLevel = (db: number): number => h - Math.max(0, Math.min(1, (db + 60) / 60)) * h
      const yGr = (db: number): number => Math.max(0, Math.min(1, -db / 30)) * h * 0.45
      g.font = `${10 * dpr}px Consolas, monospace`
      g.fillStyle = '#5c6573'
      g.strokeStyle = '#1d2229'
      g.lineWidth = 1
      for (const d of [-6, -12, -18, -24, -36, -48]) {
        const y = yLevel(d)
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(w, y)
        g.stroke()
        g.fillText(`${d}`, 4 * dpr, y - 3 * dpr)
      }
      const x = (i: number): number => (i / (HISTORY - 1)) * w
      const at = (i: number): (typeof buf)[number] => buf[(head + i) % HISTORY]
      g.fillStyle = 'rgba(94,224,138,0.07)'
      for (let i = 0; i < HISTORY; i++) if (!at(i).gate) g.fillRect(x(i), 0, w / HISTORY + 1, h)
      g.beginPath()
      g.moveTo(0, h)
      for (let i = 0; i < HISTORY; i++) g.lineTo(x(i), yLevel(at(i).inp))
      g.lineTo(w, h)
      g.closePath()
      g.fillStyle = 'rgba(138,147,163,0.18)'
      g.fill()
      g.beginPath()
      for (let i = 0; i < HISTORY; i++) g[i ? 'lineTo' : 'moveTo'](x(i), yLevel(at(i).out))
      g.strokeStyle = '#3fb6ff'
      g.lineWidth = 1.6 * dpr
      g.stroke()
      g.beginPath()
      g.moveTo(0, 0)
      for (let i = 0; i < HISTORY; i++) g.lineTo(x(i), yGr(at(i).gr))
      g.lineTo(w, 0)
      g.closePath()
      g.fillStyle = 'rgba(255,176,32,0.25)'
      g.fill()
      g.beginPath()
      for (let i = 0; i < HISTORY; i++) g[i ? 'lineTo' : 'moveTo'](x(i), yGr(at(i).nr))
      g.strokeStyle = '#4dd6c9'
      g.lineWidth = 1.2 * dpr
      g.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <>
      <div className="vp-graph-wrap vp-history">
        <canvas ref={canvas} className="vp-graph-canvas" />
        {!on && <div className="vp-graph-off">Enciende el procesador para ver la dinámica en vivo</div>}
      </div>
      <footer className="vp-graph-foot">
        <span>Últimos 12 s · niveles en dBFS · reducción de ganancia desde arriba (escala 0 … −30 dB)</span>
        <span className="vp-grow" />
        <span className="vp-legend in">Entrada</span>
        <span className="vp-legend out">Salida</span>
        <span className="vp-legend gr">Compresión + limitador</span>
        <span className="vp-legend nr">Reducción de ruido</span>
        <span className="vp-legend gate">Puerta cerrada</span>
      </footer>
    </>
  )
}

// ---- Noise reduction graph: input spectrum, noise estimate, result and gain per frequency

function NoiseGraph({ on, cfg }: { on: boolean; cfg: ProcessorConfig }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const el = canvas.current
      if (!el) return
      const [w, h] = fitCanvas(el)
      const g = el.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const dpr = devicePixelRatio
      const xOf = (f: number): number => (Math.log10(Math.max(20, f) / 20) / 3) * w
      g.strokeStyle = '#1d2229'
      g.fillStyle = '#5c6573'
      g.font = `${10 * dpr}px Consolas, monospace`
      g.lineWidth = 1
      for (const f of F_MARKS) {
        g.beginPath()
        g.moveTo(xOf(f), 0)
        g.lineTo(xOf(f), h)
        g.stroke()
        g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, xOf(f) + 3 * dpr, h - 4 * dpr)
      }
      const c = processorEngine.noiseCurves()
      if (!c) return
      const n = c.size
      // Hann-windowed bin of a full-scale sine ≈ (n/4)²
      const ref = 20 * Math.log10(n / 4)
      const toDb = (p: number): number => 10 * Math.log10(p + 1e-20) - ref
      const yLvl = (db: number): number => h - Math.max(0, Math.min(1, (db + 110) / 100)) * h
      const yGain = (gain: number): number => Math.max(0, Math.min(1, (-20 * Math.log10(Math.max(1e-4, gain))) / 40)) * h * 0.4
      const bins = c.gains.length
      const fOf = (k: number): number => (k * c.sampleRate) / n
      const line = (val: (k: number) => number, stroke: string, fill: string | null, width = 1): void => {
        g.beginPath()
        let started = false
        for (let k = 1; k < bins; k++) {
          const f = fOf(k)
          if (f < 20 || f > 20000) continue
          const y = val(k)
          if (!started) {
            if (fill) {
              g.moveTo(xOf(f), h)
              g.lineTo(xOf(f), y)
            } else g.moveTo(xOf(f), y)
            started = true
          } else g.lineTo(xOf(f), y)
        }
        if (fill) {
          g.lineTo(w, h)
          g.closePath()
          g.fillStyle = fill
          g.fill()
        }
        g.strokeStyle = stroke
        g.lineWidth = width * dpr
        g.stroke()
      }
      line((k) => yLvl(toDb(c.power[k])), 'rgba(138,147,163,0.5)', 'rgba(138,147,163,0.12)')
      line((k) => yLvl(toDb(c.power[k] * c.gains[k] * c.gains[k])), 'rgba(63,182,255,0.85)', null, 1.2)
      line((k) => yLvl(toDb(c.noise[k])), '#ffb020', null, 1.4)
      line((k) => yGain(c.gains[k]), '#4dd6c9', null, 1.6)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <>
      <div className="vp-graph-wrap">
        <canvas ref={canvas} className="vp-graph-canvas" />
        {!on && <div className="vp-graph-off">Enciende el procesador para ver el ruido en vivo</div>}
        {on && !cfg.noise.on && <div className="vp-graph-note">Reducción de ruido desactivada: se muestra lo que haría</div>}
      </div>
      <footer className="vp-graph-foot">
        <span>Atenuación por frecuencia desde arriba (0 … −40 dB)</span>
        <span className="vp-grow" />
        <span className="vp-legend in">Entrada</span>
        <span className="vp-legend nf">Ruido estimado</span>
        <span className="vp-legend out">Resultado</span>
        <span className="vp-legend nr">Atenuación</span>
      </footer>
    </>
  )
}

// ---- Module panels

function Module({ id, title, on, onToggle, live, actions, graph, children }: { id: ModuleId; title: string; on: boolean; onToggle: (v: boolean) => void; live?: ReactNode; actions?: ReactNode; graph?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section id={`vp-mod-${id}`} className={`vp-panel vp-module ${on ? '' : 'off'}`} style={{ ['--mod' as string]: COLORS[id] }}>
      <header className="vp-module-head">
        <Switch on={on} onChange={onToggle} title="Activar / desactivar" />
        <b>{title}</b>
        <span className="vp-grow" />
        {live}
      </header>
      {actions && <div className="vp-module-actions">{actions}</div>}
      <div className="vp-module-body">
        {graph && <div className="vp-module-graph">{graph}</div>}
        <div className="vp-knobs">{children}</div>
      </div>
    </section>
  )
}

function GrBadge({ pick, label = 'GR' }: { pick: (l: ProcessorLevels) => number; label?: string }): JSX.Element {
  const l = useLevels(15)
  const v = l ? pick(l) : 0
  return (
    <span className={`vp-badge ${v < -0.5 ? 'on' : ''}`}>
      {label} {v > -0.1 ? '0.0' : v.toFixed(1)} dB
    </span>
  )
}

/** Small transfer graph (input dB → output dB) with a live dot */
function TransferGraph({ curve, live, thr, range = [-80, 0] }: { curve: (x: number) => number; live: number | null; thr?: number; range?: [number, number] }): JSX.Element {
  const [lo, hi] = range
  const S = 120
  const px = (db: number): number => ((Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * S
  const pts = Array.from({ length: 81 }, (_, i) => lo + ((hi - lo) * i) / 80)
  return (
    <svg className="vp-transfer" viewBox={`0 0 ${S} ${S}`}>
      {[0.25, 0.5, 0.75].map((t) => (
        <g key={t}>
          <line x1={t * S} x2={t * S} y1={0} y2={S} className="grid" />
          <line x1={0} x2={S} y1={t * S} y2={t * S} className="grid" />
        </g>
      ))}
      <line x1={0} y1={S} x2={S} y2={0} className="unity" />
      {thr !== undefined && <line x1={px(thr)} x2={px(thr)} y1={0} y2={S} className="thr" />}
      <path d={pts.map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${(S - px(curve(x))).toFixed(1)}`).join(' ')} className="curve" />
      {live !== null && live > lo && <circle cx={px(live)} cy={S - px(curve(live))} r={3.5} className="dot" />}
    </svg>
  )
}

const offFmt =
  (off: number) =>
  (v: number): string =>
    v <= off ? 'OFF' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)

function NoiseModule({ cfg, set, on, setMsg }: { cfg: ProcessorConfig; set: SetFn; on: boolean; setMsg: (m: string) => void }): JSX.Element {
  const n = cfg.noise
  const p = (x: Partial<typeof n>): void => set({ noise: { ...n, ...x } })
  const l = useLevels(10)
  return (
    <Module
      id="noise"
      title="Reducción de ruido"
      on={n.on}
      onToggle={(v) => p({ on: v })}
      live={<GrBadge pick={(x) => x.noiseGr} />}
      actions={
        <>
          <Segmented<typeof n.mode>
            value={n.mode}
            onChange={(mode) => p({ mode })}
            options={[
              ['adaptive', 'Adaptativa'],
              ['learned', 'Perfil aprendido']
            ]}
            title="Adaptativa sigue el ruido sola; con perfil usa el ruido que capturaste"
          />
          <button
            className={`vp-btn ${l?.noiseLearning ? 'rec' : ''}`}
            disabled={!on || !!l?.noiseLearning}
            onClick={() => {
              if (processorEngine.learnNoise(2)) setMsg('Aprendiendo el ruido: 2 s de silencio…')
            }}
            title="Quédate en silencio 2 s: captura el ruido de la sala"
          >
            <Icon name="record" size={12} />
            {l?.noiseLearning ? 'Aprendiendo…' : 'Aprender'}
          </button>
          <span className="vp-dim">{n.profile ? 'Perfil guardado' : 'Sin perfil'}</span>
          {n.profile && (
            <button className="vp-btn ghost" onClick={() => p({ profile: null, mode: 'adaptive' })}>
              Borrar perfil
            </button>
          )}
          <span className="vp-grow" />
          <Switch on={n.listenRemoved} onChange={(v) => p({ listenRemoved: v })} labels={['ELIMINADO', 'ELIMINADO']} title="Escuchar solo lo que se elimina" />
        </>
      }
    >
      <Knob label="Reducción" value={n.reductionDb} min={-40} max={0} step={0.5} unit="dB" def={-18} onChange={(reductionDb) => p({ reductionDb })} />
      <Knob label="Sensibilidad" value={n.sensitivityDb} min={-10} max={10} step={0.5} unit="dB" def={0} center={0} onChange={(sensitivityDb) => p({ sensitivityDb })} />
      <Knob label="Suavizado" value={n.smoothing} min={0} max={100} unit="%" def={50} onChange={(smoothing) => p({ smoothing })} />
      <Knob label="Desde" value={Math.max(20, n.fromHz)} min={20} max={2000} log unit="Hz" def={20} format={offFmt(20)} onChange={(v) => p({ fromHz: v <= 20 ? 0 : v })} />
      <div className="vp-knob-like">
        <span className="vp-knob-label">Resolución</span>
        <Segmented<NoiseResolution>
          value={n.resolution}
          onChange={(resolution) => p({ resolution })}
          options={[
            [512, '512'],
            [1024, '1024'],
            [2048, '2048']
          ]}
          title="Tamaño de FFT: más = más fina en frecuencia y más latencia (≈ 11 / 21 / 43 ms)"
        />
      </div>
    </Module>
  )
}

function GateModule({ cfg, set, on }: { cfg: ProcessorConfig; set: SetFn; on: boolean }): JSX.Element {
  const g = cfg.gate
  const p = (x: Partial<typeof g>): void => set({ gate: { ...g, ...x } })
  const l = useLevels(20)
  const curve = (x: number): number => {
    if (g.mode === 'expander') return x >= g.thresholdDb ? x : x + Math.max(g.rangeDb, (x - g.thresholdDb) * (Math.max(1, g.ratio) - 1))
    return x >= g.thresholdDb ? x : x + g.rangeDb
  }
  const m = useMeasure()
  return (
    <Module
      id="gate"
      title="Puerta de ruido / expansor"
      on={g.on}
      onToggle={(v) => p({ on: v })}
      live={
        <>
          <span className={`vp-gate-led ${on && g.on && l?.gateOpen ? 'open' : ''}`} title="Verde = abierta" />
          <GrBadge pick={(x) => x.gateDb} />
        </>
      }
      actions={
        <>
          <Segmented<typeof g.mode>
            value={g.mode}
            onChange={(mode) => p({ mode })}
            options={[
              ['expander', 'Expansor'],
              ['gate', 'Puerta']
            ]}
            title="El expansor baja el ruido entre frases sin cortar finales; la puerta lo corta del todo"
          />
          <button
            className="vp-btn"
            disabled={!on || m.running > 0}
            title="Quédate en silencio 3 s: el umbral se pone por encima del ruido de la sala"
            onClick={() => m.run(3, 'rms', (noise) => p({ on: true, thresholdDb: Math.round(Math.min(-10, noise + 10)) }))}
          >
            {m.running ? `Silencio… ${m.running}` : 'Aprender umbral'}
          </button>
        </>
      }
      graph={<TransferGraph curve={curve} live={on && g.on ? (l?.gateLevel ?? null) : null} thr={g.thresholdDb} />}
    >
      <Knob label="Umbral" value={g.thresholdDb} min={-90} max={-10} step={0.5} unit="dB" def={-50} onChange={(thresholdDb) => p({ thresholdDb })} />
      {g.mode === 'gate' ? (
        <Knob label="Histéresis" value={g.hysteresisDb} min={0} max={20} step={0.5} unit="dB" def={4} onChange={(hysteresisDb) => p({ hysteresisDb })} />
      ) : (
        <Knob label="Ratio" value={g.ratio} min={1} max={10} step={0.1} unit=":1" def={2} onChange={(ratio) => p({ ratio })} />
      )}
      <Knob label="Rango" value={g.rangeDb} min={-80} max={0} step={1} unit="dB" def={-30} onChange={(rangeDb) => p({ rangeDb })} />
      <Knob label="Ataque" value={g.attackMs} min={0.1} max={50} step={0.1} unit="ms" log def={1} onChange={(attackMs) => p({ attackMs })} />
      <Knob label="Mantener" value={g.holdMs} min={0} max={1000} step={5} unit="ms" def={120} onChange={(holdMs) => p({ holdMs })} />
      <Knob label="Liberación" value={g.releaseMs} min={5} max={2000} step={5} unit="ms" log def={180} onChange={(releaseMs) => p({ releaseMs })} />
      <Knob label="Clave HPF" value={Math.max(20, g.keyHpfHz)} min={20} max={1000} log unit="Hz" def={20} format={offFmt(20)} onChange={(v) => p({ keyHpfHz: v <= 20 ? 0 : v })} />
      <Knob
        label="Clave LPF"
        value={g.keyLpfHz || 20000}
        min={1000}
        max={20000}
        log
        unit="Hz"
        def={20000}
        format={(v) => (v >= 20000 ? 'OFF' : `${(v / 1000).toFixed(1)}k`)}
        onChange={(v) => p({ keyLpfHz: v >= 20000 ? 0 : v })}
      />
    </Module>
  )
}

function DeEsserModule({ cfg, set }: { cfg: ProcessorConfig; set: SetFn }): JSX.Element {
  const d = cfg.deesser
  const p = (x: Partial<typeof d>): void => set({ deesser: { ...d, ...x } })
  const response = useMemo(() => {
    const bq = nodeBiquad({ type: 'bandpass', frequency: d.freq, Q: Math.max(0.3, d.q), gain: 0 }, 48000)
    return logFreqs(80, 1000, 20000).map((f) => [f, responseDb([bq], f, 48000)] as const)
  }, [d.freq, d.q])
  const S = 120
  const x = (f: number): number => (Math.log10(f / 1000) / Math.log10(20)) * S
  const y = (db: number): number => Math.max(0, Math.min(1, -db / 30)) * S
  const line = response.map(([f, db], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(db).toFixed(1)}`).join(' ')
  return (
    <Module
      id="deesser"
      title="De-esser"
      on={d.on}
      onToggle={(v) => p({ on: v })}
      live={<GrBadge pick={(l) => l.deessGr} />}
      actions={
        <>
          <Segmented<typeof d.mode>
            value={d.mode}
            onChange={(mode) => p({ mode })}
            options={[
              ['split', 'Solo agudos'],
              ['wide', 'Banda ancha']
            ]}
          />
          <span className="vp-grow" />
          <Switch on={d.listen} onChange={(v) => p({ listen: v })} labels={['ESCUCHA', 'ESCUCHA']} title="Escucha solo la banda que detecta para afinar la frecuencia" />
        </>
      }
      graph={
        <svg className="vp-transfer" viewBox={`0 0 ${S} ${S}`}>
          {[2000, 5000, 10000].map((f) => (
            <g key={f}>
              <line x1={x(f)} x2={x(f)} y1={0} y2={S} className="grid" />
              <text x={x(f) + 2} y={S - 3}>
                {f / 1000}k
              </text>
            </g>
          ))}
          <path d={`${line} L${S},${S} L0,${S} Z`} className="band" />
          <path d={line} className="curve" />
        </svg>
      }
    >
      <Knob label="Frecuencia" value={d.freq} min={2000} max={12000} step={50} unit="Hz" log def={6500} onChange={(freq) => p({ freq })} />
      <Knob label="Ancho (Q)" value={d.q} min={0.5} max={5} step={0.05} log def={1.4} onChange={(q) => p({ q })} />
      <Knob label="Umbral" value={d.thresholdDb} min={-60} max={0} step={0.5} unit="dB" def={-30} onChange={(thresholdDb) => p({ thresholdDb })} />
      <Knob label="Ratio" value={d.ratio} min={1} max={10} step={0.1} unit=":1" def={4} onChange={(ratio) => p({ ratio })} />
      <Knob label="Reducción máx." value={d.rangeDb} min={-24} max={0} step={0.5} unit="dB" def={-8} onChange={(rangeDb) => p({ rangeDb })} />
    </Module>
  )
}

function CompModule({ title, which, cfg, set }: { title: string; which: 'comp1' | 'comp2'; cfg: ProcessorConfig; set: SetFn }): JSX.Element {
  const c = cfg[which]
  const p = (x: Partial<CompParams>): void => set({ [which]: { ...c, ...x } } as Partial<ProcessorConfig>)
  const l = useLevels(20)
  const makeup = c.makeupDb + (c.autoMakeup ? autoMakeupDb(c) : 0)
  const curve = (x: number): number => compressorCurve(x, c.thresholdDb, Math.max(1, c.ratio), c.kneeDb) + makeup
  const live = c.on && l ? (which === 'comp1' ? l.comp1In : l.comp2In) : null
  const quick: Record<string, Partial<CompParams>> = {
    voz: { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 120, detector: 'peak', mix: 100 },
    radio: { thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 3, releaseMs: 70, detector: 'peak', mix: 100 },
    nivelador: { thresholdDb: -26, ratio: 2, kneeDb: 10, attackMs: 40, releaseMs: 500, detector: 'rms', mix: 100 },
    paralelo: { thresholdDb: -30, ratio: 8, kneeDb: 2, attackMs: 2, releaseMs: 100, mix: 40, detector: 'peak' }
  }
  return (
    <Module
      id={which}
      title={title}
      on={c.on}
      onToggle={(v) => p({ on: v })}
      live={<GrBadge pick={(x) => (which === 'comp1' ? x.comp1Gr : x.comp2Gr)} />}
      actions={
        <>
          <Segmented<string>
            value=""
            onChange={(k) => p({ ...quick[k], on: true })}
            options={[
              ['voz', 'Voz'],
              ['radio', 'Radio'],
              ['nivelador', 'Nivelador'],
              ['paralelo', 'Paralelo']
            ]}
            title="Ajustes rápidos"
          />
          <Segmented<CompParams['detector']>
            value={c.detector}
            onChange={(detector) => p({ detector })}
            options={[
              ['peak', 'Pico'],
              ['rms', 'RMS']
            ]}
            title="Detector: pico controla transitorios, RMS sigue el volumen percibido"
          />
          <Switch on={c.autoMakeup} onChange={(v) => p({ autoMakeup: v })} labels={['AUTO GAIN', 'AUTO GAIN']} title="Compensación automática de la ganancia perdida" />
        </>
      }
      graph={<TransferGraph curve={curve} live={live} thr={c.thresholdDb} range={[-60, 0]} />}
    >
      <Knob label="Umbral" value={c.thresholdDb} min={-60} max={0} step={0.5} unit="dB" def={which === 'comp1' ? -18 : -24} onChange={(thresholdDb) => p({ thresholdDb })} />
      <Knob label="Ratio" value={c.ratio} min={1} max={20} step={0.1} unit=":1" log def={which === 'comp1' ? 4 : 2} onChange={(ratio) => p({ ratio })} />
      <Knob label="Rodilla" value={c.kneeDb} min={0} max={24} step={0.5} unit="dB" def={6} onChange={(kneeDb) => p({ kneeDb })} />
      <Knob label="Ataque" value={c.attackMs} min={0.1} max={200} step={0.1} unit="ms" log def={which === 'comp1' ? 5 : 30} onChange={(attackMs) => p({ attackMs })} />
      <Knob label="Liberación" value={c.releaseMs} min={10} max={2000} step={5} unit="ms" log def={which === 'comp1' ? 80 : 400} onChange={(releaseMs) => p({ releaseMs })} />
      <Knob label="Compensación" value={c.makeupDb} min={-12} max={24} step={0.5} unit="dB" def={0} center={0} onChange={(makeupDb) => p({ makeupDb })} />
      <Knob label="Mezcla" value={c.mix} min={0} max={100} unit="%" def={100} onChange={(mix) => p({ mix })} />
      <Knob label="SC HPF" value={Math.max(20, c.scHpfHz)} min={20} max={500} log unit="Hz" def={20} format={offFmt(20)} onChange={(v) => p({ scHpfHz: v <= 20 ? 0 : v })} />
    </Module>
  )
}

function SaturationModule({ cfg, set }: { cfg: ProcessorConfig; set: SetFn }): JSX.Element {
  const s = cfg.saturation
  const p = (x: Partial<typeof s>): void => set({ saturation: { ...s, ...x } })
  const S = 120
  const drive = Math.pow(10, s.driveDb / 20)
  const wet = s.mix / 100
  const pts = Array.from({ length: 81 }, (_, i) => -1 + i / 40)
  const y = (v: number): number => S / 2 - v * (S / 2) * 0.9
  const xp = (v: number): number => S / 2 + v * (S / 2) * 0.9
  return (
    <Module
      id="saturation"
      title="Saturador"
      on={s.on}
      onToggle={(v) => p({ on: v })}
      actions={
        <Segmented<typeof s.mode>
          value={s.mode}
          onChange={(mode) => p({ mode })}
          options={[
            ['tube', 'Válvula'],
            ['tape', 'Cinta']
          ]}
          title="Válvula añade armónicos pares (cálida); cinta, impares (redonda)"
        />
      }
      graph={
        <svg className="vp-transfer" viewBox={`0 0 ${S} ${S}`}>
          <line x1={S / 2} x2={S / 2} y1={0} y2={S} className="grid" />
          <line x1={0} x2={S} y1={S / 2} y2={S / 2} className="grid" />
          <line x1={xp(-1)} y1={y(-1)} x2={xp(1)} y2={y(1)} className="unity" />
          <path d={pts.map((v, i) => `${i ? 'L' : 'M'}${xp(v).toFixed(1)},${y(v * (1 - wet) + saturate(v, drive, s.mode) * wet).toFixed(1)}`).join(' ')} className="curve" />
        </svg>
      }
    >
      <Knob label="Drive" value={s.driveDb} min={0} max={24} step={0.5} unit="dB" def={6} onChange={(driveDb) => p({ driveDb })} />
      <Knob label="Tono" value={s.toneHz} min={2000} max={20000} step={100} log unit="Hz" def={12000} format={(v) => (v >= 19000 ? 'OFF' : `${(v / 1000).toFixed(1)}k`)} onChange={(toneHz) => p({ toneHz })} />
      <Knob label="Mezcla" value={s.mix} min={0} max={100} unit="%" def={35} onChange={(mix) => p({ mix })} />
    </Module>
  )
}

function LimiterModule({ cfg, set }: { cfg: ProcessorConfig; set: SetFn }): JSX.Element {
  const l = cfg.limiter
  const p = (x: Partial<typeof l>): void => set({ limiter: { ...l, ...x } })
  const lv = useLevels(20)
  return (
    <Module
      id="limiter"
      title="Limitador (look-ahead)"
      on={l.on}
      onToggle={(v) => p({ on: v })}
      live={<GrBadge pick={(x) => x.limGr} />}
      graph={<TransferGraph curve={(x) => Math.min(x, l.on ? l.ceilingDb : 0)} live={lv && l.on ? lv.outPeak : null} thr={l.ceilingDb} range={[-30, 0]} />}
    >
      <Knob label="Techo" value={l.ceilingDb} min={-12} max={0} step={0.1} unit="dBFS" def={-1} onChange={(ceilingDb) => p({ ceilingDb })} />
      <Knob label="Liberación" value={l.releaseMs} min={10} max={1000} step={5} unit="ms" log def={60} onChange={(releaseMs) => p({ releaseMs })} />
      <p className="vp-note">Ninguna muestra pasa del techo: protege a VoiceMeeter, al stream y a los oídos de un grito o un golpe al micro.</p>
    </Module>
  )
}

// ---- Assistant: 3 s of silence, then 8 s of normal speech

type Phase = 'ready' | 'noise' | 'speech' | 'done'

function Assistant({ cfg, onClose, onApply }: { cfg: ProcessorConfig; onClose: () => void; onApply: (r: AutoSetupResult) => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('ready')
  const [left, setLeft] = useState(0)
  const [result, setResult] = useState<AutoSetupResult | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
    },
    []
  )

  const start = (): void => {
    const sr = processorEngine.state.sampleRate ?? 48000
    const spec = new Float32Array(PROCESSOR_FFT / 2)
    const binHz = sr / PROCESSOR_FFT
    let noiseSum = 0
    let noiseN = 0
    let peak = -100
    let speechSum = 0
    let speechN = 0
    const regionSum: Record<string, number> = {}
    let regionN = 0
    let t0 = performance.now()
    let ph: Phase = 'noise'
    setPhase('noise')
    timer.current = setInterval(() => {
      const l = processorEngine.levels()
      const el = (performance.now() - t0) / 1000
      if (!l) return
      if (ph === 'noise') {
        noiseSum += Math.pow(10, l.inRms / 10)
        noiseN++
        setLeft(Math.ceil(3 - el))
        if (el >= 3) {
          ph = 'speech'
          setPhase('speech')
          t0 = performance.now()
        }
        return
      }
      const noiseDb = 10 * Math.log10(noiseSum / Math.max(1, noiseN))
      peak = Math.max(peak, l.inPeak)
      // Only voiced frames count for the voice level and the spectrum
      if (l.inRms > noiseDb + 10) {
        speechSum += Math.pow(10, l.inRms / 10)
        speechN++
        if (processorEngine.spectrum('in', spec)) {
          for (const [k, [f0, f1]] of Object.entries(VOICE_REGIONS)) {
            let s = 0
            let n = 0
            for (let b = Math.ceil(f0 / binHz); b <= Math.floor(f1 / binHz) && b < spec.length; b++) {
              s += spec[b]
              n++
            }
            regionSum[k] = (regionSum[k] ?? 0) + (n ? s / n : -140)
          }
          regionN++
        }
      }
      setLeft(Math.ceil(8 - el))
      if (el >= 8) {
        clearInterval(timer.current!)
        timer.current = null
        const m: VoiceMeasurement = {
          noiseDb,
          peakDb: peak,
          speechDb: speechN ? 10 * Math.log10(speechSum / speechN) : -100,
          regions:
            regionN > 5
              ? {
                  low: regionSum.low / regionN,
                  mud: regionSum.mud / regionN,
                  box: regionSum.box / regionN,
                  presence: regionSum.presence / regionN,
                  air: regionSum.air / regionN
                }
              : undefined
        }
        setResult(autoSetup(cfg, m))
        setPhase('done')
      }
    }, 50)
  }

  return (
    <div className="vp-modal" onClick={onClose}>
      <div className="vp-panel vp-assistant" onClick={(e) => e.stopPropagation()}>
        <header className="vp-module-head">
          <b>Asistente automático</b>
          <span className="vp-grow" />
          <button className="vp-btn ghost" onClick={onClose} title="Cerrar">
            <Icon name="close" size={14} />
          </button>
        </header>
        {phase === 'ready' && (
          <>
            <p>Colócate a la distancia de siempre del micrófono. El asistente medirá:</p>
            <ol>
              <li>3 segundos de silencio (ruido de la sala).</li>
              <li>8 segundos hablando normal, como en una llamada o un directo.</li>
            </ol>
            <p className="vp-dim">Con eso ajusta la ganancia, la puerta, los compresores, el de-esser y corrige el EQ hacia una voz equilibrada. Mejor partir de un preset de uso.</p>
            <button className="vp-btn primary" onClick={start}>
              Empezar
            </button>
          </>
        )}
        {(phase === 'noise' || phase === 'speech') && (
          <div className="vp-countdown">
            <div>
              <small>{phase === 'noise' ? 'Paso 1 de 2' : 'Paso 2 de 2'}</small>
              <b>{phase === 'noise' ? 'Silencio…' : 'Habla ahora con normalidad…'}</b>
            </div>
            <span>{left}</span>
          </div>
        )}
        {phase === 'done' && result && (
          <>
            <ul className="vp-notes">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <div className="vp-row">
              <button className="vp-btn primary" onClick={() => onApply(result)} disabled={Object.keys(result.patch).length === 0}>
                Aplicar
              </button>
              <button
                className="vp-btn"
                onClick={() => {
                  setResult(null)
                  setPhase('ready')
                }}
              >
                Repetir
              </button>
              <button className="vp-btn ghost" onClick={onClose}>
                Descartar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
