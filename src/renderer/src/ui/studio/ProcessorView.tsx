import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { processorEngine, PROCESSOR_FFT, type ProcessorLevels, type ProcessorState } from '../../core/audio/ProcessorEngine'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import { autoTrim, logFreqs } from '../../core/mixer/mixer'
import type { CompParams } from '../../core/processor/dynamics'
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
  parsePreset,
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
import { compressorCurve } from '../../core/studio/dsp'
import { openTextFile, saveFile } from '../storage'
import { useStore } from '../store'
import { BarMeter, fitCanvas, fmtDb, MeterScale, Num, Segmented, usePolled } from './widgets'
import './mixer.css'
import './processor.css'

// Mic processor tab: one microphone → full voice chain → VoiceMeeter (or any output).

export function useProcessorState(): ProcessorState {
  const [s, set] = useState(processorEngine.state)
  useEffect(() => processorEngine.onState(set), [])
  return s
}

type Patch = Partial<ProcessorConfig> | ((c: ProcessorConfig) => ProcessorConfig)

function useProcessor(): [ProcessorConfig, (p: Patch) => void] {
  const { data, update } = useStore()
  return [data.processor, (p) => update('processor', (c) => (typeof p === 'function' ? p(c) : { ...c, ...p }))]
}

/** Live levels, polled (null when the processor is off) */
function useLevels(ms = 50): ProcessorLevels | null {
  return usePolled(() => processorEngine.levels(), ms)
}

/** Peak hold that falls back after `ms` */
function useHold(v: number, ms = 1500): number {
  const h = useRef({ v: -100, t: 0 })
  const now = performance.now()
  if (v > h.current.v || now - h.current.t > ms) h.current = { v, t: now }
  return h.current.v
}

const isVirtual = (label: string): boolean => /voicemeeter|vb-audio|cable|virtual|vaio/i.test(label)

export function ProcessorView(): JSX.Element {
  const [cfg, set] = useProcessor()
  const state = useProcessorState()
  const [inputs, setInputs] = useState<InputDevice[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [msg, setMsg] = useState('')
  const [presetName, setPresetName] = useState('')
  const [assistant, setAssistant] = useState(false)
  const [help, setHelp] = useState(false)
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

  const outputLabel = cfg.output.deviceId ? (outputs.find((o) => o.deviceId === cfg.output.deviceId)?.label ?? null) : null
  const monitorLabel = cfg.monitor.deviceId ? (outputs.find((o) => o.deviceId === cfg.monitor.deviceId)?.label ?? null) : null
  const warnings = processorWarnings(cfg, outputLabel, monitorLabel)
  const vmOutputs = outputs.filter((o) => isVirtual(o.label))
  const channels = on ? (state.channels ?? 1) : 2

  const power = (): void => {
    if (state.status === 'on' || state.status === 'starting') processorEngine.stop()
    else void processorEngine.start(cfg)
  }

  const applyPreset = (): void => {
    set((c) => applyChain(c, buildPreset(c.useId, c.micId)))
    const u = USES.find((x) => x.id === cfg.useId)
    const m = MICS.find((x) => x.id === cfg.micId)
    setMsg(`Preset aplicado: ${u?.name} · ${m?.name}`)
  }

  const exportPreset = async (): Promise<void> => {
    const name = presetName.trim() || 'procesador'
    const path = await saveFile(`${name}.json`, serializePreset(name, cfg))
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
    <div className="st-proc" style={{ ['--strip' as string]: '#3fb6ff' }}>
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Procesador de micrófono</h2>
          <div className="st-row">
            {on && (
              <span className="st-muted st-small st-mono" title="Latencia estimada: dispositivos + procesamiento">
                {state.sampleRate} Hz · ≈ {state.latencyMs} ms
              </span>
            )}
            <button className={`st-btn proc-bypass ${cfg.bypass ? 'active' : ''}`} onClick={() => set({ bypass: !cfg.bypass })} title="Escuchar el micrófono sin procesar (tecla B)">
              {cfg.bypass ? 'BYPASS (sin procesar)' : 'A/B · Bypass'}
            </button>
            <button className={`st-btn ${on ? 'on' : 'primary'}`} onClick={power}>
              {state.status === 'starting' ? 'Arrancando…' : on ? '⏻ Apagar' : '⏻ Encender'}
            </button>
          </div>
        </header>
        {state.status === 'error' && <p className="st-error">{state.error}</p>}

        <div className="proc-io">
          <label className="proc-field">
            <span>Micrófono</span>
            <select value={cfg.input.deviceId ?? ''} onChange={(e) => set({ input: { ...cfg.input, deviceId: e.target.value || null } })}>
              <option value="">Predeterminado del sistema</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.virtual ? '◇ ' : '🎙 '}
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="proc-field proc-narrow">
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
          <label className="proc-field">
            <span>Salida (hacia VoiceMeeter)</span>
            <select value={cfg.output.deviceId ?? ''} onChange={(e) => set({ output: { ...cfg.output, deviceId: e.target.value || null } })}>
              <option value="">Predeterminada del sistema</option>
              {outputs.map((o, i) => (
                <option key={o.deviceId} value={o.deviceId}>
                  {isVirtual(o.label) ? '◆ ' : '🔊 '}
                  {o.label || `Salida ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label className="st-inline proc-check">
            <input type="checkbox" checked={cfg.output.mute} onChange={(e) => set({ output: { ...cfg.output, mute: e.target.checked } })} />
            Silenciar salida
          </label>
          <label className="proc-field proc-narrow">
            <span>Frecuencia de muestreo</span>
            <select value={cfg.sampleRate ?? 0} onChange={(e) => set({ sampleRate: Number(e.target.value) || null })}>
              <option value={0}>Del dispositivo</option>
              <option value={44100}>44.1 kHz</option>
              <option value={48000}>48 kHz</option>
              <option value={96000}>96 kHz</option>
            </select>
          </label>
        </div>

        <div className="proc-io">
          <label className="st-inline proc-check">
            <input type="checkbox" checked={cfg.monitor.on} onChange={(e) => set({ monitor: { ...cfg.monitor, on: e.target.checked } })} />
            🎧 Escucha
          </label>
          <label className="proc-field">
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
          <div className="proc-field proc-wide">
            <Num label="Nivel escucha" value={cfg.monitor.levelDb} min={-40} max={6} step={0.5} unit="dB" onChange={(levelDb) => set({ monitor: { ...cfg.monitor, levelDb } })} />
          </div>
          {vmOutputs.length > 0 && (
            <div className="st-row proc-vm">
              <span className="st-muted st-small">VoiceMeeter detectado:</span>
              {vmOutputs.slice(0, 4).map((o) => (
                <button key={o.deviceId} className={`st-btn ${cfg.output.deviceId === o.deviceId ? 'on' : ''}`} onClick={() => set({ output: { ...cfg.output, deviceId: o.deviceId } })} title={o.label}>
                  ◆ {shortVm(o.label)}
                </button>
              ))}
            </div>
          )}
          <span className="st-grow" />
          <button className="st-btn ghost" onClick={() => setHelp((h) => !h)}>
            {help ? 'Ocultar guía' : '¿Cómo conectarlo a VoiceMeeter?'}
          </button>
        </div>

        {help && <VoiceMeeterGuide />}

        <div className="proc-io proc-presets">
          <label className="proc-field">
            <span>Uso</span>
            <select value={cfg.useId} onChange={(e) => set({ useId: e.target.value })} title={USES.find((u) => u.id === cfg.useId)?.hint}>
              {USES.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="proc-field">
            <span>Tipo de micrófono</span>
            <select value={cfg.micId} onChange={(e) => set({ micId: e.target.value })} title={MICS.find((m) => m.id === cfg.micId)?.hint}>
              {MICS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button className="st-btn primary" onClick={applyPreset} title="Carga una cadena completa pensada para ese uso y ese micrófono">
            Aplicar preset
          </button>
          <button className="st-btn" onClick={() => setAssistant(true)} disabled={!on} title={on ? 'Mide tu voz y el ruido y ajusta ganancia, puerta, compresores y EQ' : 'Enciende el procesador primero'}>
            ✨ Asistente automático
          </button>
          <span className="st-grow" />
          <select value="" onChange={(e) => {
            const p = cfg.userPresets.find((x) => x.id === e.target.value)
            if (p) {
              set((c) => applyChain(c, p.apply))
              setMsg(`Preset «${p.name}» aplicado.`)
            }
          }}>
            <option value="">Mis presets…</option>
            {cfg.userPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input placeholder="Nombre del preset" value={presetName} onChange={(e) => setPresetName(e.target.value)} style={{ width: 150 }} />
          <button
            className="st-btn"
            onClick={() => {
              set((c) => saveUserPreset(c, presetName))
              setMsg('Preset guardado.')
              setPresetName('')
            }}
          >
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
          <button className="st-btn ghost" onClick={exportPreset} title="Exportar la cadena actual a un archivo">
            Exportar
          </button>
          <button className="st-btn ghost" onClick={importPreset} title="Importar un preset desde un archivo">
            Importar
          </button>
          <button
            className="st-btn ghost"
            onClick={() => confirm('¿Restablecer todo el procesamiento (EQ, dinámica y ganancias)?') && set((c) => ({ ...defaultProcessor(), input: c.input, output: c.output, monitor: c.monitor, sampleRate: c.sampleRate, userPresets: c.userPresets, useId: c.useId, micId: c.micId }))}
          >
            Restablecer
          </button>
        </div>
        {msg && <p className="st-muted st-small">{msg}</p>}
        {warnings.length > 0 && (
          <ul className="st-warnings">
            {warnings.map((w) => (
              <li key={w.message} className={w.level}>
                ⚠ {w.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <SignalFlow cfg={cfg} set={set} on={on} />
      <EqPanel cfg={cfg} set={set} on={on} sampleRate={state.sampleRate ?? cfg.sampleRate ?? 48000} />

      <div className="proc-grid">
        <GainBox cfg={cfg} set={set} on={on} />
        <GateBox cfg={cfg} set={set} on={on} />
        <DeEsserBox cfg={cfg} set={set} />
        <CompBox title="Compresor 1 · picos" which="comp1" cfg={cfg} set={set} />
        <CompBox title="Compresor 2 · nivelador" which="comp2" cfg={cfg} set={set} />
        <LimiterBox cfg={cfg} set={set} />
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

function shortVm(label: string): string {
  const m = /voicemeeter\s+(aux\s+input|vaio3\s+input|input)/i.exec(label)
  if (m) return m[0].replace(/voicemeeter\s+/i, 'VM ')
  return label.replace(/\(.*\)/, '').trim().slice(0, 24)
}

function VoiceMeeterGuide(): JSX.Element {
  return (
    <div className="proc-guide">
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
      <p className="st-muted st-small">
        Alternativa: si el micro ya entra en VoiceMeeter, toma aquí como entrada «VoiceMeeter Out B2», procésalo y devuélvelo por «VoiceMeeter AUX Input».
      </p>
    </div>
  )
}

// ---- Signal flow with live gain reduction

function SignalFlow({ cfg, set, on }: { cfg: ProcessorConfig; set: (p: Patch) => void; on: boolean }): JSX.Element {
  const l = useLevels()
  const inHold = useHold(l?.inPeak ?? -100)
  const outHold = useHold(l?.outPeak ?? -100)
  const gr = (v: number | undefined): string => (v === undefined || v > -0.1 ? '0.0' : v.toFixed(1))
  const block = (key: string, title: string, active: boolean, toggle: (() => void) | null, value: string, reduction: number, extra?: string): JSX.Element => (
    <div key={key} className={`proc-block ${active ? 'active' : ''}`}>
      <button className={`proc-led ${active ? 'on' : ''}`} onClick={toggle ?? undefined} disabled={!toggle} title={toggle ? 'Activar / desactivar' : undefined} />
      <b>{title}</b>
      <div className="proc-gr">
        <i style={{ transform: `scaleX(${Math.min(1, -reduction / 20)})` }} />
      </div>
      <span className="st-mono">{value}</span>
      {extra && <small>{extra}</small>}
    </div>
  )
  const flowEq = block('eq', 'EQ', cfg.eq.on, () => set({ eq: { ...cfg.eq, on: !cfg.eq.on } }), `${cfg.eq.bands.filter((b) => b.on).length} bandas`, 0)
  const dyn = [
    block('deess', 'De-esser', cfg.deesser.on, () => set({ deesser: { ...cfg.deesser, on: !cfg.deesser.on } }), `${gr(l?.deessGr)} dB`, l?.deessGr ?? 0),
    block('c1', 'Comp 1', cfg.comp1.on, () => set({ comp1: { ...cfg.comp1, on: !cfg.comp1.on } }), `${gr(l?.comp1Gr)} dB`, l?.comp1Gr ?? 0),
    block('c2', 'Comp 2', cfg.comp2.on, () => set({ comp2: { ...cfg.comp2, on: !cfg.comp2.on } }), `${gr(l?.comp2Gr)} dB`, l?.comp2Gr ?? 0)
  ]
  return (
    <section className={`st-panel proc-flow ${cfg.bypass ? 'bypassed' : ''}`}>
      {block('in', 'Entrada', true, null, `${fmtDb(inHold)} dBFS`, 0, `${cfg.inputGainDb > 0 ? '+' : ''}${cfg.inputGainDb} dB`)}
      <span className="proc-arrow">→</span>
      {block('gate', cfg.gate.mode === 'gate' ? 'Puerta' : 'Expansor', cfg.gate.on, () => set({ gate: { ...cfg.gate, on: !cfg.gate.on } }), on && cfg.gate.on ? (l?.gateOpen ? 'abierta' : 'cerrada') : '—', l?.gateDb ?? 0)}
      <span className="proc-arrow">→</span>
      {cfg.eqPosition === 'pre' && (
        <>
          {flowEq}
          <span className="proc-arrow">→</span>
        </>
      )}
      {dyn.flatMap((d, i) => [d, <span key={`a${i}`} className="proc-arrow">→</span>])}
      {cfg.eqPosition === 'post' && (
        <>
          {flowEq}
          <span className="proc-arrow">→</span>
        </>
      )}
      {block('lim', 'Limitador', cfg.limiter.on, () => set({ limiter: { ...cfg.limiter, on: !cfg.limiter.on } }), `${gr(l?.limGr)} dB`, l?.limGr ?? 0, `techo ${cfg.limiter.ceilingDb} dB`)}
      <span className="proc-arrow">→</span>
      {block('out', 'Salida', !cfg.output.mute, () => set({ output: { ...cfg.output, mute: !cfg.output.mute } }), `${fmtDb(outHold)} dBFS`, 0, cfg.output.mute ? 'MUTE' : `${cfg.outputGainDb > 0 ? '+' : ''}${cfg.outputGainDb} dB`)}
    </section>
  )
}

// ---- Parametric EQ with live spectrum

const EQ_W = 900
const EQ_H = 260
const EQ_RANGE = 18
const EQ_FREQS = logFreqs(240)
const xOfF = (f: number): number => (Math.log10(f / 20) / 3) * EQ_W
const fOfX = (x: number): number => 20 * Math.pow(1000, Math.max(0, Math.min(EQ_W, x)) / EQ_W)
const yOfDb = (db: number): number => EQ_H / 2 - (Math.max(-EQ_RANGE * 1.4, Math.min(EQ_RANGE * 1.4, db)) / EQ_RANGE) * (EQ_H / 2)
const dbOfY = (y: number): number => ((EQ_H / 2 - y) / (EQ_H / 2)) * EQ_RANGE
const BAND_COLORS = ['#ff6b8b', '#ffb020', '#ffe066', '#5ee08a', '#4dd6c9', '#3fb6ff', '#b48cff', '#ff9a5a']

type SpecMode = 'both' | 'out' | 'in' | 'off'

function EqPanel({ cfg, set, on, sampleRate }: { cfg: ProcessorConfig; set: (p: Patch) => void; on: boolean; sampleRate: number }): JSX.Element {
  const [sel, setSel] = useState(0)
  const [spec, setSpec] = useState<SpecMode>('both')
  const svg = useRef<SVGSVGElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const eq = cfg.eq
  const curve = useMemo(() => eqCurve(eq, EQ_FREQS, sampleRate), [eq, sampleRate])
  const selCurve = useMemo(() => (eq.bands[sel] ? eqCurve(eq, EQ_FREQS, sampleRate, sel) : null), [eq, sel, sampleRate])

  const setBand = (i: number, p: Partial<ParamBand>): void => set((c) => ({ ...c, eq: { ...c.eq, bands: c.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } }))
  const addBand = (freq = 1000, gainDb = 0): void => {
    if (eq.bands.length >= MAX_BANDS) return
    set((c) => ({ ...c, eq: { ...c.eq, bands: [...c.eq.bands, band('peaking', Math.round(freq), Math.round(gainDb * 2) / 2, 1)] } }))
    setSel(eq.bands.length)
  }
  const removeBand = (i: number): void => {
    set((c) => ({ ...c, eq: { ...c.eq, bands: c.eq.bands.filter((_, j) => j !== i) } }))
    setSel((s) => Math.max(0, s >= i ? s - 1 : s))
  }

  // Spectrum behind the curve
  useEffect(() => {
    if (!on || spec === 'off') {
      const c = canvas.current
      if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
      return
    }
    const bufIn = new Float32Array(PROCESSOR_FFT / 2)
    const bufOut = new Float32Array(PROCESSOR_FFT / 2)
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      g.clearRect(0, 0, w, h)
      const binHz = sampleRate / PROCESSOR_FFT
      const plot = (buf: Float32Array, fill: string, stroke: string): void => {
        g.beginPath()
        g.moveTo(0, h)
        const cols = 300
        for (let k = 0; k <= cols; k++) {
          const f0 = 20 * Math.pow(1000, k / cols)
          const f1 = 20 * Math.pow(1000, (k + 1) / cols)
          let m = -140
          for (let b = Math.max(1, Math.floor(f0 / binHz)); b <= Math.max(1, Math.ceil(f1 / binHz)) && b < buf.length; b++) if (buf[b] > m) m = buf[b]
          // −100…−10 dBFS fills the height
          const y = h - Math.max(0, Math.min(1, (m + 100) / 90)) * h
          g.lineTo((k / cols) * w, y)
        }
        g.lineTo(w, h)
        g.closePath()
        g.fillStyle = fill
        g.fill()
        g.strokeStyle = stroke
        g.lineWidth = 1
        g.stroke()
      }
      if ((spec === 'both' || spec === 'in') && processorEngine.spectrum('in', bufIn)) plot(bufIn, 'rgba(138,147,163,0.12)', 'rgba(138,147,163,0.45)')
      if ((spec === 'both' || spec === 'out') && processorEngine.spectrum('out', bufOut)) plot(bufOut, 'rgba(63,182,255,0.16)', 'rgba(63,182,255,0.7)')
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [on, spec, sampleRate])

  const pointer = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * EQ_W, y: ((e.clientY - r.top) / r.height) * EQ_H }
  }
  const path = (vals: number[]): string => vals.map((db, i) => `${i ? 'L' : 'M'}${xOfF(EQ_FREQS[i]).toFixed(1)},${yOfDb(db).toFixed(1)}`).join(' ')
  const b = eq.bands[sel]

  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Ecualizador paramétrico</h2>
        <div className="st-row">
          <label className="st-inline">
            <input type="checkbox" checked={eq.on} onChange={(e) => set({ eq: { ...eq, on: e.target.checked } })} />
            Activo
          </label>
          <Segmented<ProcessorConfig['eqPosition']>
            value={cfg.eqPosition}
            onChange={(eqPosition) => set({ eqPosition })}
            options={[
              ['pre', 'EQ → Comp'],
              ['post', 'Comp → EQ']
            ]}
            title="Orden: ecualizar antes de comprimir (clásico) o después"
          />
          <Segmented<SpecMode>
            value={spec}
            onChange={setSpec}
            options={[
              ['both', 'Entrada + salida'],
              ['out', 'Salida'],
              ['in', 'Entrada'],
              ['off', 'Sin analizador']
            ]}
            title="Espectro en vivo detrás de la curva"
          />
          <button className="st-btn" onClick={() => addBand()} disabled={eq.bands.length >= MAX_BANDS}>
            + Banda
          </button>
          <button className="st-btn ghost" onClick={() => set({ eq: { ...eq, bands: eq.bands.map((x) => ({ ...x, gainDb: 0 })) } })}>
            Ganancias a 0
          </button>
          <button className="st-btn ghost" onClick={() => set({ eq: { ...eq, bands: defaultBands() } })}>
            Bandas por defecto
          </button>
        </div>
      </header>

      <div className="proc-eq-wrap">
        <canvas ref={canvas} className="proc-eq-canvas" />
        <svg
          ref={svg}
          className="st-eq proc-eq"
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
            if ((e.target as Element).closest('.handle')) return
            const { x, y } = pointer(e)
            addBand(fOfX(x), Math.max(-EQ_RANGE, Math.min(EQ_RANGE, dbOfY(y))))
          }}
          onWheel={(e) => {
            if (!b || !hasQ(b.type)) return
            setBand(sel, { q: Math.round(Math.max(0.1, Math.min(20, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12))) * 100) / 100 })
          }}
        >
          {[30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000].map((f) => (
            <g key={f}>
              <line x1={xOfF(f)} x2={xOfF(f)} y1={0} y2={EQ_H} className="grid" />
              <text x={xOfF(f) + 3} y={EQ_H - 4}>
                {f >= 1000 ? `${f / 1000}k` : f}
              </text>
            </g>
          ))}
          {[-18, -12, -6, 0, 6, 12, 18].map((d) => (
            <g key={d}>
              <line x1={0} x2={EQ_W} y1={yOfDb(d)} y2={yOfDb(d)} className={d === 0 ? 'zero' : 'grid'} />
              <text x={3} y={yOfDb(d) - 3}>
                {d > 0 ? `+${d}` : d}
              </text>
            </g>
          ))}
          {selCurve && <path d={path(selCurve)} className="proc-sel-curve" style={{ stroke: BAND_COLORS[sel % 8] }} />}
          <path d={`${path(curve)} L${EQ_W},${EQ_H / 2} L0,${EQ_H / 2} Z`} className="fill" />
          <path d={path(curve)} className="curve" />
          {eq.bands.map((x, i) => {
            const cx = xOfF(Math.max(20, Math.min(20000, x.freq)))
            const cy = yOfDb(hasGain(x.type) && eq.on && x.on ? x.gainDb : 0)
            return (
              <g
                key={i}
                className={`handle ${sel === i ? 'sel' : ''} ${x.on ? '' : 'off'}`}
                style={{ ['--strip' as string]: BAND_COLORS[i % 8] }}
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
      <p className="st-muted st-small">
        Arrastra los puntos · rueda = ancho (Q) de la banda elegida · doble clic en el gráfico = nueva banda · clic derecho en un punto = activar/desactivar. Gris = entrada, azul = salida.
      </p>

      <div className="proc-bands">
        {eq.bands.map((x, i) => (
          <div key={i} className={`proc-band ${sel === i ? 'sel' : ''} ${x.on ? '' : 'off'}`} style={{ ['--strip' as string]: BAND_COLORS[i % 8] }} onClick={() => setSel(i)}>
            <div className="st-row">
              <input type="checkbox" checked={x.on} onChange={(e) => setBand(i, { on: e.target.checked })} title="Activar banda" />
              <b>{i + 1}</b>
              <select value={x.type} onChange={(e) => setBand(i, { type: e.target.value as BandType })}>
                {BAND_TYPES.map(([t, label]) => (
                  <option key={t} value={t}>
                    {label}
                  </option>
                ))}
              </select>
              <button className="st-btn ghost proc-x" onClick={(e) => {
                  e.stopPropagation()
                  removeBand(i)
                }} title="Quitar banda">
                ✕
              </button>
            </div>
            <label className="proc-bnum">
              <span>Frec.</span>
              <input type="number" min={20} max={20000} value={x.freq} onChange={(e) => setBand(i, { freq: clamp(Number(e.target.value), 20, 20000, x.freq) })} />
              <i>Hz</i>
            </label>
            {hasGain(x.type) && (
              <label className="proc-bnum">
                <span>Gan.</span>
                <input type="number" min={-24} max={24} step={0.5} value={x.gainDb} onChange={(e) => setBand(i, { gainDb: clamp(Number(e.target.value), -24, 24, x.gainDb) })} />
                <i>dB</i>
              </label>
            )}
            {hasQ(x.type) && (
              <label className="proc-bnum">
                <span>{hasSlope(x.type) ? 'Res.' : 'Q'}</span>
                <input type="number" min={0.1} max={20} step={0.05} value={x.q} onChange={(e) => setBand(i, { q: clamp(Number(e.target.value), 0.1, 20, x.q) })} />
                <i />
              </label>
            )}
            {hasSlope(x.type) && (
              <label className="proc-bnum">
                <span>Pend.</span>
                <select value={x.slope} onChange={(e) => setBand(i, { slope: Number(e.target.value) as ParamBand['slope'] })}>
                  {[12, 24, 36, 48].map((s) => (
                    <option key={s} value={s}>
                      {s} dB/oct
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

// ---- Module boxes

function Box({ title, on, onToggle, children, extra, live }: { title: string; on?: boolean; onToggle?: (on: boolean) => void; children: ReactNode; extra?: ReactNode; live?: ReactNode }): JSX.Element {
  return (
    <section className={`st-panel proc-box ${on === false ? 'off' : ''}`}>
      <header className="st-row">
        {onToggle && <input type="checkbox" checked={!!on} onChange={(e) => onToggle(e.target.checked)} title="Activar / desactivar" />}
        <b className="st-box-title">{title}</b>
        <span className="st-grow" />
        {extra}
        {live}
      </header>
      {children}
    </section>
  )
}

function GrBadge({ pick, label = 'GR' }: { pick: (l: ProcessorLevels) => number; label?: string }): JSX.Element {
  const l = useLevels(80)
  const v = l ? pick(l) : 0
  return (
    <span className={`proc-badge st-mono ${v < -0.5 ? 'on' : ''}`}>
      {label} {v > -0.1 ? '0.0' : v.toFixed(1)} dB
    </span>
  )
}

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

function GainBox({ cfg, set, on }: { cfg: ProcessorConfig; set: (p: Patch) => void; on: boolean }): JSX.Element {
  const l = useLevels(60)
  const inHold = useHold(l?.inPeak ?? -100)
  const outHold = useHold(l?.outPeak ?? -100)
  const m = useMeasure()
  const [note, setNote] = useState('')
  return (
    <Box title="Ganancia">
      <Num label="Entrada" value={cfg.inputGainDb} min={GAIN_MIN} max={GAIN_MAX} step={0.5} unit="dB" onChange={(inputGainDb) => set({ inputGainDb })} />
      <Num label="Salida" value={cfg.outputGainDb} min={-24} max={24} step={0.5} unit="dB" onChange={(outputGainDb) => set({ outputGainDb })} />
      <div className="st-row">
        <label className="st-inline">
          <input type="checkbox" checked={cfg.phaseInvert} onChange={(e) => set({ phaseInvert: e.target.checked })} />
          Invertir fase (Ø)
        </label>
        <span className="st-grow" />
        <button
          className="st-btn"
          disabled={!on || m.running > 0}
          title="Habla o grita como lo harás de verdad durante 5 s: los picos quedarán en −12 dBFS"
          onClick={() =>
            m.run(5, 'peak', (peak) => {
              const t = autoTrim(cfg.inputGainDb, peak)
              if (t === null) setNote('No se oyó nada.')
              else {
                set({ inputGainDb: Math.max(GAIN_MIN, Math.min(GAIN_MAX, t)) })
                setNote(`Pico ${peak.toFixed(1)} dBFS → ganancia ${t} dB`)
              }
            })
          }
        >
          {m.running ? `Habla… ${m.running}` : 'Ganancia automática'}
        </button>
      </div>
      {note && <p className="st-muted st-small">{note}</p>}
      <div className="proc-meters">
        <BarMeter label="IN" db={l?.inPeak ?? -100} hold={inHold} />
        <BarMeter label="IN rms" db={l?.inRms ?? -100} hold={-100} />
        <BarMeter label="OUT" db={l?.outPeak ?? -100} hold={outHold} />
        <BarMeter label="OUT rms" db={l?.outRms ?? -100} hold={-100} />
        <MeterScale marks={[-48, -36, -24, -18, -12, -6, 0]} />
      </div>
      <p className="st-muted st-small">Ideal: picos de entrada entre −18 y −6 dBFS. Sube primero el preamplificador del micro; la ganancia digital no quita ruido.</p>
    </Box>
  )
}

function GateBox({ cfg, set, on }: { cfg: ProcessorConfig; set: (p: Patch) => void; on: boolean }): JSX.Element {
  const g = cfg.gate
  const p = (x: Partial<typeof g>): void => set({ gate: { ...g, ...x } })
  const l = useLevels(80)
  const m = useMeasure()
  return (
    <Box
      title="Puerta de ruido / expansor"
      on={g.on}
      onToggle={(v) => p({ on: v })}
      extra={<span className={`proc-gate-led ${on && g.on && l?.gateOpen ? 'open' : ''}`} title="Verde = abierta" />}
      live={<GrBadge pick={(x) => x.gateDb} />}
    >
      <div className="st-row">
        <Segmented<typeof g.mode>
          value={g.mode}
          onChange={(mode) => p({ mode })}
          options={[
            ['expander', 'Expansor (suave)'],
            ['gate', 'Puerta (corta)']
          ]}
        />
        <span className="st-grow" />
        <button
          className="st-btn"
          disabled={!on || m.running > 0}
          title="Quédate en silencio 3 s: el umbral se pone por encima del ruido de la sala"
          onClick={() => m.run(3, 'rms', (noise) => p({ on: true, thresholdDb: Math.round(Math.min(-10, noise + 10)) }))}
        >
          {m.running ? `Silencio… ${m.running}` : 'Aprender ruido'}
        </button>
      </div>
      <Num label="Umbral" value={g.thresholdDb} min={-90} max={-10} unit="dB" onChange={(thresholdDb) => p({ thresholdDb })} />
      {g.mode === 'gate' ? (
        <Num label="Histéresis" value={g.hysteresisDb} min={0} max={20} unit="dB" onChange={(hysteresisDb) => p({ hysteresisDb })} />
      ) : (
        <Num label="Ratio" value={g.ratio} min={1} max={10} step={0.1} unit=":1" onChange={(ratio) => p({ ratio })} />
      )}
      <Num label="Rango" value={g.rangeDb} min={-80} max={0} unit="dB" onChange={(rangeDb) => p({ rangeDb })} />
      <Num label="Ataque" value={g.attackMs} min={0.1} max={50} step={0.1} unit="ms" onChange={(attackMs) => p({ attackMs })} />
      <Num label="Mantener" value={g.holdMs} min={0} max={1000} step={5} unit="ms" onChange={(holdMs) => p({ holdMs })} />
      <Num label="Liberación" value={g.releaseMs} min={5} max={2000} step={5} unit="ms" onChange={(releaseMs) => p({ releaseMs })} />
      <p className="st-muted st-small">El expansor baja el ruido entre frases sin cortar finales de palabra; la puerta lo corta del todo (ideal para teclado y ventilador).</p>
    </Box>
  )
}

function DeEsserBox({ cfg, set }: { cfg: ProcessorConfig; set: (p: Patch) => void }): JSX.Element {
  const d = cfg.deesser
  const p = (x: Partial<typeof d>): void => set({ deesser: { ...d, ...x } })
  return (
    <Box title="De-esser" on={d.on} onToggle={(v) => p({ on: v })} live={<GrBadge pick={(x) => x.deessGr} />}>
      <div className="st-row">
        <Segmented<typeof d.mode>
          value={d.mode}
          onChange={(mode) => p({ mode })}
          options={[
            ['split', 'Solo agudos'],
            ['wide', 'Banda ancha']
          ]}
        />
        <span className="st-grow" />
        <button className={`st-btn ${d.listen ? 'on' : ''}`} onClick={() => p({ listen: !d.listen })} title="Escucha solo la banda que detecta para afinar la frecuencia">
          🎧 Escuchar sibilancia
        </button>
      </div>
      <Num label="Frecuencia" value={d.freq} min={2000} max={12000} step={100} unit="Hz" onChange={(freq) => p({ freq })} />
      <Num label="Umbral" value={d.thresholdDb} min={-60} max={0} unit="dB" onChange={(thresholdDb) => p({ thresholdDb })} />
      <Num label="Reducción máx." value={d.rangeDb} min={-24} max={0} step={0.5} unit="dB" onChange={(rangeDb) => p({ rangeDb })} />
      <p className="st-muted st-small">Suaviza las «s», «z» y «ch» que pinchan. Voces masculinas ≈ 5–6 kHz, femeninas ≈ 6–8 kHz.</p>
    </Box>
  )
}

function CompBox({ title, which, cfg, set }: { title: string; which: 'comp1' | 'comp2'; cfg: ProcessorConfig; set: (p: Patch) => void }): JSX.Element {
  const c = cfg[which]
  const p = (x: Partial<CompParams>): void => set({ [which]: { ...c, ...x } } as Partial<ProcessorConfig>)
  const pts = Array.from({ length: 61 }, (_, i) => -60 + i).map((x) => [x, compressorCurve(x, c.thresholdDb, Math.max(1, c.ratio), c.kneeDb) + c.makeupDb])
  const px = (db: number): number => ((db + 60) / 60) * 120
  const quick: Record<string, Partial<CompParams>> = {
    voz: { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 120, detector: 'peak' },
    radio: { thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 3, releaseMs: 70, detector: 'peak' },
    nivelador: { thresholdDb: -26, ratio: 2, kneeDb: 10, attackMs: 40, releaseMs: 500, detector: 'rms' },
    paralelo: { thresholdDb: -30, ratio: 8, kneeDb: 2, attackMs: 2, releaseMs: 100, mix: 40, detector: 'peak' }
  }
  return (
    <Box title={title} on={c.on} onToggle={(v) => p({ on: v })} live={<GrBadge pick={(x) => (which === 'comp1' ? x.comp1Gr : x.comp2Gr)} />}>
      <div className="st-row">
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
      </div>
      <div className="st-comp">
        <svg className="st-curve" viewBox="0 0 120 120">
          {[-48, -36, -24, -12].map((d) => (
            <g key={d}>
              <line x1={px(d)} x2={px(d)} y1={0} y2={120} className="grid" />
              <line x1={0} x2={120} y1={120 - px(d)} y2={120 - px(d)} className="grid" />
            </g>
          ))}
          <line x1={0} y1={120} x2={120} y2={0} className="zero" />
          <line x1={px(c.thresholdDb)} x2={px(c.thresholdDb)} y1={0} y2={120} className="proc-thr" />
          <path d={pts.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${(120 - px(y)).toFixed(1)}`).join(' ')} className="curve" />
        </svg>
        <div className="st-comp-params">
          <Num label="Umbral" value={c.thresholdDb} min={-60} max={0} step={0.5} unit="dB" onChange={(thresholdDb) => p({ thresholdDb })} />
          <Num label="Ratio" value={c.ratio} min={1} max={20} step={0.1} unit=":1" onChange={(ratio) => p({ ratio })} />
          <Num label="Rodilla" value={c.kneeDb} min={0} max={24} step={0.5} unit="dB" onChange={(kneeDb) => p({ kneeDb })} />
          <Num label="Ataque" value={c.attackMs} min={0.1} max={200} step={0.1} unit="ms" onChange={(attackMs) => p({ attackMs })} />
          <Num label="Liberación" value={c.releaseMs} min={10} max={2000} step={5} unit="ms" onChange={(releaseMs) => p({ releaseMs })} />
          <Num label="Compensación" value={c.makeupDb} min={-12} max={24} step={0.5} unit="dB" onChange={(makeupDb) => p({ makeupDb })} />
          <Num label="Mezcla" value={c.mix} min={0} max={100} unit="%" onChange={(mix) => p({ mix })} />
        </div>
      </div>
    </Box>
  )
}

function LimiterBox({ cfg, set }: { cfg: ProcessorConfig; set: (p: Patch) => void }): JSX.Element {
  const l = cfg.limiter
  const p = (x: Partial<typeof l>): void => set({ limiter: { ...l, ...x } })
  return (
    <Box title="Limitador (look-ahead)" on={l.on} onToggle={(v) => p({ on: v })} live={<GrBadge pick={(x) => x.limGr} />}>
      <Num label="Techo" value={l.ceilingDb} min={-12} max={0} step={0.1} unit="dBFS" onChange={(ceilingDb) => p({ ceilingDb })} />
      <Num label="Liberación" value={l.releaseMs} min={10} max={1000} step={5} unit="ms" onChange={(releaseMs) => p({ releaseMs })} />
      <p className="st-muted st-small">Ninguna muestra pasa del techo: protege a VoiceMeeter, al stream y a los oídos de un grito o un golpe al micro. Déjalo siempre activo.</p>
    </Box>
  )
}

// ---- Assistant: 3 s of silence, then 8 s of normal speech

type Phase = 'ready' | 'noise' | 'speech' | 'done'

function Assistant({ cfg, onClose, onApply }: { cfg: ProcessorConfig; onClose: () => void; onApply: (r: AutoSetupResult) => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('ready')
  const [left, setLeft] = useState(0)
  const [result, setResult] = useState<AutoSetupResult | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])

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
    <div className="st-help" onClick={onClose}>
      <div className="st-panel proc-assistant" onClick={(e) => e.stopPropagation()}>
        <header className="st-panel-head">
          <h2>Asistente automático</h2>
          <button className="st-btn ghost" onClick={onClose}>
            ✕
          </button>
        </header>
        {phase === 'ready' && (
          <>
            <p>Colócate a la distancia de siempre del micrófono. El asistente medirá:</p>
            <ol>
              <li>3 segundos de silencio (ruido de la sala).</li>
              <li>8 segundos hablando normal, como en una llamada o un directo.</li>
            </ol>
            <p className="st-muted st-small">Con eso ajusta la ganancia, la puerta, los compresores, el de-esser y corrige el EQ hacia una voz equilibrada. Mejor partir de un preset de uso.</p>
            <button className="st-btn primary" onClick={start}>
              Empezar
            </button>
          </>
        )}
        {phase === 'noise' && (
          <div className="proc-countdown">
            <b>🤫 Silencio…</b>
            <span className="st-mono">{left}</span>
          </div>
        )}
        {phase === 'speech' && (
          <div className="proc-countdown">
            <b>🗣 Habla ahora con normalidad…</b>
            <span className="st-mono">{left}</span>
          </div>
        )}
        {phase === 'done' && result && (
          <>
            <ul className="proc-notes">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <div className="st-row">
              <button className="st-btn primary" onClick={() => onApply(result)} disabled={Object.keys(result.patch).length === 0}>
                Aplicar
              </button>
              <button
                className="st-btn"
                onClick={() => {
                  setResult(null)
                  setPhase('ready')
                }}
              >
                Repetir
              </button>
              <button className="st-btn ghost" onClick={onClose}>
                Descartar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
