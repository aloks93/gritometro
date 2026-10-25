import { useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { mixerEngine, SPECTRUM_FFT, type MixerState } from '../../core/audio/MixerEngine'
import { listInputs, type InputDevice } from '../../core/audio/MicrophoneService'
import {
  applyMidi,
  applyPreset,
  addAuxBus,
  autoTrim,
  createStrip,
  defaultEqBands,
  describeMidiKey,
  eqResponse,
  faderToPos,
  FADER_MIN,
  gainAdvice,
  learnMidi,
  levelStatus,
  loadScene,
  logFreqs,
  MAX_NOTCHES,
  MAX_AUX_BUSES,
  MAX_STRIPS,
  midiKey,
  parseMidi,
  parseMixer,
  posToFader,
  removeBus,
  routingWarnings,
  saveScene,
  saveUserPreset,
  serializeMixer,
  STRIP_PRESETS,
  type Bus,
  type EqBand,
  type MidiTargetKind,
  type MixerConfig,
  type Monitor,
  type Strip
} from '../../core/mixer/mixer'
import { addNotch, FeedbackDetector, type FeedbackCandidate } from '../../core/studio/feedback'
import { encodeWavChannels } from '../../core/studio/analysis'
import { compressorCurve } from '../../core/studio/dsp'
import { openTextFile, saveFile, toBase64 } from '../storage'
import { useStore } from '../store'
import { useStudioPrefs } from './MonitorView'
import { fmtTime, Segmented } from './widgets'
import './mixer.css'

const METER_MIN = -60

export function useMixerState(): MixerState {
  const [s, set] = useState(mixerEngine.state)
  useEffect(() => mixerEngine.onState(set), [])
  return s
}

function useMixer(): [MixerConfig, (fn: (m: MixerConfig) => MixerConfig) => void] {
  const { data, update } = useStore()
  return [data.mixer, (fn) => update('mixer', fn)]
}

/** Live meters update the DOM directly (60 fps through React state would re-render every strip) */
function useMeterLoop(cfg: MixerConfig, on: boolean, refs: MutableRefObject<Map<string, HTMLElement>>): void {
  const holds = useRef(new Map<string, { db: number; t: number }>())
  const stageHolds = useRef(new Map<string, { db: number; t: number }>())
  useEffect(() => {
    if (!on) return
    let raf = 0
    const pct = (db: number): number => Math.max(0, Math.min(1, (db - METER_MIN) / -METER_MIN))
    const setBar = (key: string, db: number): void => {
      const el = refs.current.get(key)
      if (el) el.style.transform = `scaleY(${pct(db)})`
      const hold = refs.current.get(`${key}:hold`)
      if (hold) {
        const now = performance.now()
        const h = holds.current.get(key)
        const v = !h || db > h.db || now - h.t > 1500 ? { db, t: now } : h
        holds.current.set(key, v)
        hold.style.bottom = `${pct(v.db) * 100}%`
        hold.classList.toggle('clip', v.db > -0.5)
      }
    }
    const setText = (key: string, text: string, cls?: [string, boolean]): void => {
      const el = refs.current.get(key)
      if (!el) return
      if (el.textContent !== text) el.textContent = text
      if (cls) el.classList.toggle(cls[0], cls[1])
    }
    /** Gain-staging row: live bar plus a 3 s peak hold that drives the colour and the value */
    const setStage = (key: string, db: number): number => {
      const now = performance.now()
      const h = stageHolds.current.get(key)
      const v = !h || db > h.db || now - h.t > 3000 ? { db, t: now } : h
      stageHolds.current.set(key, v)
      const bar = refs.current.get(key)
      if (bar) {
        bar.style.transform = `scaleX(${pct(v.db)})`
        bar.dataset.status = levelStatus(v.db)
      }
      setText(`${key}:v`, v.db <= -99 ? '—' : `${v.db.toFixed(1)} dBFS`)
      return v.db
    }
    const pre = cfg.meterPoint === 'pre'
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      for (const s of cfg.strips) {
        const l = mixerEngine.stripLevel(s.id)
        if (!l) continue
        setBar(`${s.id}:L`, pre ? l.prePeakL : l.peakL)
        setBar(`${s.id}:R`, pre ? l.prePeakR : l.peakR)
        setText(`${s.id}:lim`, s.limiter.on && l.limGr < -0.1 ? l.limGr.toFixed(1) : '')
        setText(`${s.id}:limval`, s.limiter.on ? `${l.limGr.toFixed(1)} dB` : '—', ['on', l.limGr < -0.1])
        setText(`${s.id}:duck`, s.duck.on && l.duckDb < -0.5 ? `DUCK ${l.duckDb.toFixed(0)} dB` : '', ['on', l.duckDb < -0.5])
        setText(`${s.id}:duckval`, s.duck.on ? `${l.duckDb.toFixed(1)} dB` : '—', ['on', l.duckDb < -0.5])
        if (refs.current.has(`${s.id}:stage:in`)) {
          const inH = setStage(`${s.id}:stage:in`, l.inPeak)
          const preH = setStage(`${s.id}:stage:pre`, Math.max(l.prePeakL, l.prePeakR))
          setStage(`${s.id}:stage:post`, Math.max(l.peakL, l.peakR))
          const advice = gainAdvice(inH, preH)
          setText(`${s.id}:advice`, advice.message)
          const el = refs.current.get(`${s.id}:advice`)
          if (el) el.dataset.status = advice.status
        }
        setText(`${s.id}:clip`, 'CLIP', ['on', l.inPeak > -1])
        setText(`${s.id}:gr`, s.comp.on ? `${l.gr.toFixed(1)}` : '', ['on', l.gr < -0.5])
        for (const k of [`${s.id}:gate`, `${s.id}:gateled`]) refs.current.get(k)?.classList.toggle('open', s.gate.on && l.gateOpen)
        const grBar = refs.current.get(`${s.id}:grbar`)
        if (grBar) grBar.style.transform = `scaleY(${Math.min(1, -l.gr / 20)})`
      }
      for (const b of cfg.buses) {
        const l = mixerEngine.busLevel(b.id)
        if (!l) continue
        setBar(`${b.id}:L`, l.peakL)
        setBar(`${b.id}:R`, l.peakR)
        setText(`${b.id}:gr`, b.limiter && l.gr < -0.1 ? `LIM ${l.gr.toFixed(1)}` : '', ['on', l.gr < -0.1])
        if (mixerEngine.isRecording(b.id)) setText(`${b.id}:rec`, fmtTime(mixerEngine.recordedSeconds(b.id)))
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [cfg, on, refs])
}

type LearnTarget = { kind: MidiTargetKind; id: string }

/** Web MIDI: mapped controls drive the mixer; in learn mode the next control is mapped to the target */
function useMidi(setCfg: (fn: (m: MixerConfig) => MixerConfig) => void, cfg: MixerConfig): { inputs: string[]; error: string; learn: LearnTarget | null; setLearn: (t: LearnTarget | null) => void } {
  const [inputs, setInputs] = useState<string[]>([])
  const [error, setError] = useState('')
  const [learn, setLearn] = useState<LearnTarget | null>(null)
  const learnRef = useRef(learn)
  learnRef.current = learn
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const setRef = useRef(setCfg)
  setRef.current = setCfg
  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      setError('Este equipo no ofrece MIDI.')
      return
    }
    let access: MIDIAccess | null = null
    let alive = true
    const onMsg = (e: MIDIMessageEvent): void => {
      const m = e.data ? parseMidi(e.data) : null
      if (!m) return
      const target = learnRef.current
      if (target) {
        if (m.type === 'noteoff') return
        setRef.current((c) => learnMidi(c, midiKey(m), target.kind, target.id))
        setLearn(null)
        return
      }
      if (cfgRef.current.midi.some((x) => x.key === midiKey(m))) setRef.current((c) => applyMidi(c, m))
    }
    const bind = (): void => {
      if (!access) return
      const names: string[] = []
      access.inputs.forEach((i) => {
        i.onmidimessage = onMsg
        names.push(i.name ?? 'MIDI')
      })
      setInputs(names)
    }
    navigator
      .requestMIDIAccess()
      .then((a) => {
        if (!alive) return
        access = a
        bind()
        a.onstatechange = bind
      })
      .catch(() => setError('No se pudo abrir MIDI en este equipo.'))
    return () => {
      alive = false
      if (!access) return
      access.onstatechange = null
      access.inputs.forEach((i) => (i.onmidimessage = null))
    }
  }, [])
  return { inputs, error, learn, setLearn }
}

export function MixerView(): JSX.Element {
  const [cfg, setCfg] = useMixer()
  const state = useMixerState()
  const { data } = useStore()
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState<string | null>(cfg.strips[0]?.id ?? null)
  const [sceneName, setSceneName] = useState('')
  const [msg, setMsg] = useState('')
  const [midiOpen, setMidiOpen] = useState(false)
  const midi = useMidi(setCfg, cfg)
  const refs = useRef(new Map<string, HTMLElement>())
  const [, force] = useState(0)
  const on = state.status === 'on'
  useMeterLoop(cfg, on, refs)

  useEffect(() => {
    const load = (): void => {
      listInputs().then(setDevices).catch(() => setDevices([]))
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => setOutputs(d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'communications' && x.deviceId !== 'default')))
        .catch(() => setOutputs([]))
    }
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  }, [])

  // Stable ref callbacks per key, so React doesn't detach/attach them on every render
  const regCache = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const reg = (key: string): ((el: HTMLElement | null) => void) => {
    let fn = regCache.current.get(key)
    if (!fn) {
      fn = (el) => {
        if (el) refs.current.set(key, el)
        else refs.current.delete(key)
      }
      regCache.current.set(key, fn)
    }
    return fn
  }
  const patchStrip = (id: string, p: Partial<Strip> | ((s: Strip) => Strip)): void =>
    setCfg((m) => ({ ...m, strips: m.strips.map((s) => (s.id === id ? (typeof p === 'function' ? p(s) : { ...s, ...p }) : s)) }))
  const patchBus = (id: string, p: Partial<Bus>): void => setCfg((m) => ({ ...m, buses: m.buses.map((b) => (b.id === id ? { ...b, ...p } : b)) }))

  const addStrip = (): void => {
    const s = createStrip(cfg.strips.length)
    setCfg((m) => ({ ...m, strips: [...m.strips, s] }))
    setSelected(s.id)
  }

  const removeStrip = (id: string): void => {
    const s = cfg.strips.find((x) => x.id === id)
    if (!s || !confirm(`¿Quitar la entrada «${s.name}»?`)) return
    setCfg((m) => ({ ...m, strips: m.strips.filter((x) => x.id !== id) }))
    if (selected === id) setSelected(null)
  }

  const toggleRec = async (b: Bus): Promise<void> => {
    if (mixerEngine.isRecording(b.id)) {
      const rec = await mixerEngine.stopRecording(b.id)
      if (!rec || rec.left.length === 0) return
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const path = await saveFile(`bus-${b.label}-${stamp}.wav`, toBase64(encodeWavChannels([rec.left, rec.right], rec.sampleRate, data.studio.wavFormat)), 'base64')
      setMsg(path ? `Grabación estéreo de ${b.label} guardada en ${path}` : 'Grabación descartada.')
    } else if (mixerEngine.startRecording(b.id)) {
      setMsg(`Grabando ${b.label} (${b.name}) en estéreo…`)
    }
    force((n) => n + 1)
  }

  const exportCfg = async (): Promise<void> => {
    const path = await saveFile('mezclador.json', serializeMixer(cfg))
    if (path) setMsg(`Configuración guardada en ${path}`)
  }

  const importCfg = async (): Promise<void> => {
    const text = await openTextFile(['json'])
    if (!text) return
    try {
      const parsed = parseMixer(text)
      setCfg((m) => ({ ...m, ...parsed }))
      setMsg('Configuración cargada.')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const warnings = routingWarnings(cfg)
  const sel = cfg.strips.find((s) => s.id === selected) ?? null
  const channelCount = (deviceId: string | null): number => mixerEngine.deviceInfo().find((d) => d.deviceId === (deviceId ?? ''))?.channels ?? 8

  return (
    <div className="st-mixer">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Mezclador virtual</h2>
          <div className="st-row">
            <button className={`st-btn ${on ? 'rec on' : 'primary'}`} onClick={() => (on || state.status === 'starting' ? mixerEngine.stop() : mixerEngine.start(cfg))}>
              {state.status === 'starting' ? 'Abriendo…' : on ? '⏻ Apagar' : '⏻ Encender'}
            </button>
            <label className="st-inline">
              Muestreo
              <select value={cfg.sampleRate ?? ''} onChange={(e) => setCfg((m) => ({ ...m, sampleRate: e.target.value ? Number(e.target.value) : null }))}>
                <option value="">Automático</option>
                {[44100, 48000, 96000].map((r) => (
                  <option key={r} value={r}>
                    {r / 1000} kHz
                  </option>
                ))}
              </select>
            </label>
            <button className="st-btn" disabled={cfg.strips.length >= MAX_STRIPS} onClick={addStrip}>
              + Entrada
            </button>
            <button
              className="st-btn"
              disabled={cfg.buses.filter((b) => b.custom).length >= MAX_AUX_BUSES}
              onClick={() => setCfg((m) => addAuxBus(m))}
              title="Bus auxiliar C (monitores de escenario): recibe las entradas antes de su fader, para que el monitor no cambie al mover la mezcla"
            >
              + Bus C
            </button>
          </div>
        </header>
        <div className="st-row">
          <select value="" onChange={(e) => e.target.value && setCfg((m) => loadScene(m, e.target.value))} disabled={cfg.scenes.length === 0}>
            <option value="">{cfg.scenes.length ? 'Cargar escena…' : 'Sin escenas guardadas'}</option>
            {cfg.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input placeholder="Nombre de la escena" value={sceneName} onChange={(e) => setSceneName(e.target.value)} style={{ width: 170 }} />
          <button
            className="st-btn"
            onClick={() => {
              setCfg((m) => saveScene(m, sceneName))
              setMsg(`Escena «${sceneName.trim() || `Escena ${cfg.scenes.length + 1}`}» guardada.`)
              setSceneName('')
            }}
          >
            Guardar escena
          </button>
          {cfg.scenes.length > 0 && (
            <select value="" onChange={(e) => e.target.value && confirm('¿Borrar esa escena?') && setCfg((m) => ({ ...m, scenes: m.scenes.filter((s) => s.id !== e.target.value) }))}>
              <option value="">Borrar escena…</option>
              {cfg.scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <span className="st-grow" />
          <Segmented<MixerConfig['meterPoint']>
            value={cfg.meterPoint}
            onChange={(meterPoint) => setCfg((m) => ({ ...m, meterPoint }))}
            options={[
              ['pre', 'Pre-fader'],
              ['post', 'Post-fader']
            ]}
            title="Dónde leen los medidores de los canales: tras el procesamiento (pre) o tras el fader (post)"
          />
          <button className={`st-btn ${midiOpen ? 'on' : ''}`} onClick={() => setMidiOpen((o) => !o)} title="Controlador MIDI">
            MIDI{cfg.midi.length ? ` (${cfg.midi.length})` : ''}
          </button>
          <button className="st-btn ghost" onClick={importCfg}>
            Abrir…
          </button>
          <button className="st-btn ghost" onClick={exportCfg}>
            Exportar
          </button>
        </div>
        {state.status === 'error' && <p className="st-error">{state.error}</p>}
        {!on && state.status !== 'starting' && (
          <p className="st-muted st-small">
            Configura las entradas y enciende el mezclador. Cada entrada es un micrófono o un canal de tu interfaz; envíala a los buses <b>A</b> (salidas físicas) o <b>B</b>{' '}
            (internos: grabación y análisis). Las entradas nuevas solo van a B1 para que no se acoplen con los altavoces.
          </p>
        )}
        {warnings.length > 0 && (
          <ul className="st-warnings">
            {warnings.map((w, i) => (
              <li key={i}>⚠ {w.message}</li>
            ))}
          </ul>
        )}
        {msg && <p className="st-small">{msg}</p>}
        <MonitorRow monitor={cfg.monitor} buses={cfg.buses} outputs={outputs} cued={cfg.strips.filter((s) => s.cue)} onChange={(p) => setCfg((m) => ({ ...m, monitor: { ...m.monitor, ...p } }))} onClearCue={() => setCfg((m) => ({ ...m, strips: m.strips.map((s) => ({ ...s, cue: false })) }))} />
        {midiOpen && <MidiPanel cfg={cfg} midi={midi} onRemove={(key) => setCfg((m) => ({ ...m, midi: m.midi.filter((x) => x.key !== key) }))} />}
      </section>

      <section className={`st-console meter-${cfg.meterPoint}`}>
        {cfg.strips.map((s) => (
          <StripView
            key={s.id}
            s={s}
            buses={cfg.buses}
            devices={devices}
            channels={channelCount(s.input.deviceId)}
            error={state.stripErrors[s.id]}
            selected={selected === s.id}
            onSelect={() => setSelected(s.id)}
            onChange={(p) => patchStrip(s.id, p)}
            onRemove={() => removeStrip(s.id)}
            reg={reg}
          />
        ))}
        <div className="st-console-sep" />
        {cfg.buses.map((b) => (
          <BusView
            key={b.id}
            b={b}
            outputs={outputs}
            on={on}
            recording={mixerEngine.isRecording(b.id)}
            onChange={(p) => patchBus(b.id, p)}
            onRec={() => toggleRec(b)}
            onRemove={() => confirm(`¿Quitar el bus ${b.label}? Las entradas dejarán de enviarle señal.`) && setCfg((m) => removeBus(m, b.id))}
            reg={reg}
          />
        ))}
      </section>

      {sel && (
        <StripEditor
          s={sel}
          cfg={cfg}
          onChange={(p) => patchStrip(sel.id, p)}
          reg={reg}
          others={cfg.strips.filter((x) => x.id !== sel.id)}
          onCopyTo={(id) => patchStrip(id, (t) => ({ ...t, hpf: sel.hpf, gate: sel.gate, eq: sel.eq, comp: sel.comp, limiter: sel.limiter, notches: sel.notches }))}
          onSavePreset={(name) => {
            setCfg((m) => saveUserPreset(m, sel, name))
            setMsg(`Preset «${name.trim() || sel.name}» guardado.`)
          }}
          onDeletePreset={(id) => setCfg((m) => ({ ...m, userPresets: m.userPresets.filter((p) => p.id !== id) }))}
        />
      )}
    </div>
  )
}

function Meter({ id, reg }: { id: string; reg: (k: string) => (el: HTMLElement | null) => void }): JSX.Element {
  return (
    <div className="st-vmeter">
      {(['L', 'R'] as const).map((ch) => (
        <div key={ch} className="st-vmeter-ch">
          <div className="st-vmeter-fill" ref={reg(`${id}:${ch}`)} />
          <div className="st-vmeter-hold" ref={reg(`${id}:${ch}:hold`)} />
        </div>
      ))}
    </div>
  )
}

function Fader({ db, onChange }: { db: number; onChange: (db: number) => void }): JSX.Element {
  return (
    <div className="st-fader">
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(faderToPos(db) * 1000)}
        onChange={(e) => onChange(posToFader(Number(e.target.value) / 1000))}
        onDoubleClick={() => onChange(0)}
        title="Doble clic = 0 dB"
      />
      <span className="st-fader-scale">
        {[12, 6, 0, -10, -20, -40, -60].map((d) => (
          <i key={d} style={{ bottom: `${faderToPos(d) * 100}%` }}>
            {d === -60 ? '-∞' : d > 0 ? `+${d}` : d}
          </i>
        ))}
      </span>
    </div>
  )
}

function inputValue(s: Strip): string {
  return s.input.mode === 'mix' ? 'mix' : s.input.mode === 'mono' ? `m${s.input.left}` : `s${s.input.left}`
}

function StripView({
  s,
  buses,
  devices,
  channels,
  error,
  selected,
  onSelect,
  onChange,
  onRemove,
  reg
}: {
  s: Strip
  buses: Bus[]
  devices: InputDevice[]
  channels: number
  error?: string
  selected: boolean
  onSelect: () => void
  onChange: (p: Partial<Strip>) => void
  onRemove: () => void
  reg: (k: string) => (el: HTMLElement | null) => void
}): JSX.Element {
  const n = Math.max(2, Math.min(32, channels))
  return (
    <div className={`st-strip ${selected ? 'sel' : ''} ${s.mute ? 'muted' : ''}`} style={{ ['--strip' as string]: s.color }} onMouseDown={onSelect}>
      <div className="st-strip-top">
        <input className="st-strip-name" value={s.name} onChange={(e) => onChange({ name: e.target.value })} />
        <button className="st-x" onClick={onRemove} title="Quitar entrada">
          ×
        </button>
      </div>
      <select value={s.input.deviceId ?? ''} onChange={(e) => onChange({ input: { ...s.input, deviceId: e.target.value || null } })} title="Dispositivo de entrada">
        <option value="">Predeterminado</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
      <select
        value={inputValue(s)}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'mix') onChange({ input: { ...s.input, mode: 'mix' } })
          else if (v[0] === 'm') onChange({ input: { ...s.input, mode: 'mono', left: Number(v.slice(1)) } })
          else onChange({ input: { ...s.input, mode: 'stereo', left: Number(v.slice(1)), right: Number(v.slice(1)) + 1 } })
        }}
        title="Canal del dispositivo"
      >
        <option value="mix">Mezcla (mono)</option>
        {Array.from({ length: n }, (_, i) => (
          <option key={`m${i}`} value={`m${i}`}>
            Canal {i + 1}
          </option>
        ))}
        {Array.from({ length: Math.floor(n / 2) }, (_, i) => (
          <option key={`s${i * 2}`} value={`s${i * 2}`}>
            Estéreo {i * 2 + 1}-{i * 2 + 2}
          </option>
        ))}
      </select>
      {error && <div className="st-strip-err">{error}</div>}
      <label className="st-knob" title="Trim de entrada (doble clic = 0)">
        <span>
          TRIM <b>{s.trimDb > 0 ? '+' : ''}{s.trimDb}</b>
        </span>
        <input type="range" min={-24} max={36} step={0.5} value={s.trimDb} onChange={(e) => onChange({ trimDb: Number(e.target.value) })} onDoubleClick={() => onChange({ trimDb: 0 })} />
        <i className="st-clip" ref={reg(`${s.id}:clip`)}>
          CLIP
        </i>
      </label>
      <div className="st-fx-row">
        <button className={s.phaseInvert ? 'on' : ''} onClick={() => onChange({ phaseInvert: !s.phaseInvert })} title="Invertir polaridad">
          Ø
        </button>
        <button className={s.hpf.on ? 'on' : ''} onClick={() => onChange({ hpf: { ...s.hpf, on: !s.hpf.on } })} title={`Paso alto ${s.hpf.hz} Hz`}>
          HPF
        </button>
        <button className={s.eq.on ? 'on' : ''} onClick={() => onChange({ eq: { ...s.eq, on: !s.eq.on } })}>
          EQ
        </button>
      </div>
      <div className="st-fx-row">
        <button className={`st-gate ${s.gate.on ? 'on' : ''}`} onClick={() => onChange({ gate: { ...s.gate, on: !s.gate.on } })} title="Puerta de ruido (el punto se enciende cuando está abierta)">
          GATE <i ref={reg(`${s.id}:gate`)} />
        </button>
        <button className={s.comp.on ? 'on' : ''} onClick={() => onChange({ comp: { ...s.comp, on: !s.comp.on } })} title="Compresor (reducción en dB)">
          COMP <small ref={reg(`${s.id}:gr`)} />
        </button>
        <button className={s.limiter.on ? 'on' : ''} onClick={() => onChange({ limiter: { ...s.limiter, on: !s.limiter.on } })} title={`Limitador del canal a ${s.limiter.ceilingDb} dBFS`}>
          LIM <small ref={reg(`${s.id}:lim`)} />
        </button>
      </div>
      <label className="st-knob" title="Panorama (doble clic = centro)">
        <span>
          PAN <b>{s.pan === 0 ? 'C' : s.pan < 0 ? `L${Math.round(-s.pan * 100)}` : `R${Math.round(s.pan * 100)}`}</b>
        </span>
        <input type="range" min={-1} max={1} step={0.02} value={s.pan} onChange={(e) => onChange({ pan: Number(e.target.value) })} onDoubleClick={() => onChange({ pan: 0 })} />
      </label>
      <div className="st-sends">
        {buses.map((b) => (
          <button
            key={b.id}
            className={`${s.sends.includes(b.id) ? 'on' : ''} ${b.kind} ${b.custom ? 'aux' : ''}`}
            onClick={() => onChange({ sends: s.sends.includes(b.id) ? s.sends.filter((x) => x !== b.id) : [...s.sends, b.id] })}
            title={`${s.sends.includes(b.id) ? 'Quitar de' : 'Enviar a'} ${b.label} · ${b.name}`}
          >
            {b.label}
          </button>
        ))}
      </div>
      <div className="st-duck" ref={reg(`${s.id}:duck`)} />
      <div className="st-strip-body">
        <Meter id={s.id} reg={reg} />
        <Fader db={s.faderDb} onChange={(faderDb) => onChange({ faderDb })} />
        <div className="st-grbar" title="Reducción de ganancia del compresor">
          <i ref={reg(`${s.id}:grbar`)} />
        </div>
      </div>
      <div className="st-strip-db">{s.faderDb <= FADER_MIN ? '-∞' : `${s.faderDb > 0 ? '+' : ''}${s.faderDb.toFixed(1)}`} dB</div>
      <div className="st-ms">
        <button className={`mute ${s.mute ? 'on' : ''}`} onClick={() => onChange({ mute: !s.mute })}>
          M
        </button>
        <button className={`solo ${s.solo ? 'on' : ''}`} onClick={() => onChange({ solo: !s.solo })}>
          S
        </button>
        <button className={`cue ${s.cue ? 'on' : ''}`} onClick={() => onChange({ cue: !s.cue })} title="Escucha previa (PFL): oír solo este canal en el monitor, antes del fader">
          CUE
        </button>
      </div>
    </div>
  )
}

function BusView({
  b,
  outputs,
  on,
  recording,
  onChange,
  onRec,
  onRemove,
  reg
}: {
  b: Bus
  outputs: MediaDeviceInfo[]
  on: boolean
  recording: boolean
  onChange: (p: Partial<Bus>) => void
  onRec: () => void
  onRemove: () => void
  reg: (k: string) => (el: HTMLElement | null) => void
}): JSX.Element {
  const [prefs, setPrefs] = useStudioPrefs()
  const analysed = prefs.analysisSource === b.id
  return (
    <div className={`st-strip st-bus ${b.kind} ${b.mute ? 'muted' : ''}`}>
      <div className="st-strip-top">
        <b className="st-bus-label">{b.label}</b>
        <input className="st-strip-name" value={b.name} onChange={(e) => onChange({ name: e.target.value })} />
        {b.custom && (
          <button className="st-x" onClick={onRemove} title="Quitar bus">
            ×
          </button>
        )}
      </div>
      {b.kind === 'out' ? (
        <select value={b.deviceId ?? ''} onChange={(e) => onChange({ deviceId: e.target.value || null })} title="Dispositivo de salida">
          <option value="">Salida predeterminada</option>
          {outputs.map((o, i) => (
            <option key={o.deviceId} value={o.deviceId}>
              {o.label || `Salida ${i + 1}`}
            </option>
          ))}
        </select>
      ) : (
        <div className="st-bus-kind">Bus interno</div>
      )}
      <div className="st-fx-row">
        <button className={b.limiter ? 'on' : ''} onClick={() => onChange({ limiter: !b.limiter })} title="Limitador a −1 dBFS">
          LIM
        </button>
        <button className={b.mono ? 'on' : ''} onClick={() => onChange({ mono: !b.mono })} title="Sumar a mono">
          MONO
        </button>
        {b.custom && (
          <button className={b.pre ? 'on' : ''} onClick={() => onChange({ pre: !b.pre })} title={b.pre ? 'Pre-fader: el monitor no cambia al mover los faders' : 'Post-fader: sigue a la mezcla'}>
            {b.pre ? 'PRE' : 'POST'}
          </button>
        )}
      </div>
      <div className="st-bus-gr" ref={reg(`${b.id}:gr`)} />
      <div className="st-fx-row">
        <button className={`st-recbtn ${recording ? 'on' : ''}`} disabled={!on} onClick={onRec} title="Grabar este bus en WAV estéreo">
          ● {recording ? <span ref={reg(`${b.id}:rec`)}>REC</span> : 'REC'}
        </button>
        <button className={analysed ? 'on' : ''} onClick={() => setPrefs({ analysisSource: analysed ? 'input' : b.id })} title="Analizar este bus en Monitor, Sonómetro, Grabadora…">
          🔍
        </button>
      </div>
      <div className="st-strip-body">
        <Meter id={b.id} reg={reg} />
        <Fader db={b.faderDb} onChange={(faderDb) => onChange({ faderDb })} />
      </div>
      <div className="st-strip-db">{b.faderDb <= FADER_MIN ? '-∞' : `${b.faderDb > 0 ? '+' : ''}${b.faderDb.toFixed(1)}`} dB</div>
      <div className="st-ms">
        <button className={`mute ${b.mute ? 'on' : ''}`} onClick={() => onChange({ mute: !b.mute })}>
          M
        </button>
      </div>
    </div>
  )
}

/** Listens for 5 s and sets the trim so the loudest peak lands at −12 dBFS */
function AutoTrimButton({ s, onTrim }: { s: Strip; onTrim: (db: number) => void }): JSX.Element {
  const state = useMixerState()
  const [left, setLeft] = useState(0)
  const [note, setNote] = useState('')
  const run = async (): Promise<void> => {
    let max = -100
    setNote('')
    const t0 = performance.now()
    while (performance.now() - t0 < 5000) {
      const l = mixerEngine.stripLevel(s.id)
      // The input meter is post-trim: undo the current trim to compare against the target
      if (l) max = Math.max(max, l.inPeak - s.trimDb)
      setLeft(Math.ceil((5000 - (performance.now() - t0)) / 1000))
      await new Promise((r) => setTimeout(r, 50))
    }
    setLeft(0)
    const trim = autoTrim(0, max)
    if (trim === null) setNote('No se oyó nada.')
    else {
      onTrim(trim)
      setNote(`Trim ${trim > 0 ? '+' : ''}${trim} dB`)
    }
  }
  return (
    <>
      <button className="st-btn" disabled={state.status !== 'on' || left > 0} onClick={run} title="Habla o canta fuerte durante 5 s: ajusta el trim para que los picos queden en −12 dBFS">
        {left > 0 ? `Escuchando… ${left}` : 'Ganancia automática'}
      </button>
      {note && <span className="st-small st-muted">{note}</span>}
    </>
  )
}

// ---- Processing editor for the selected strip

const EQ_FREQS = logFreqs(160)
const EQ_W = 560
const EQ_H = 200
const EQ_RANGE = 18
const xOfF = (f: number): number => (Math.log10(f / 20) / 3) * EQ_W
const fOfX = (x: number): number => 20 * Math.pow(1000, Math.max(0, Math.min(EQ_W, x)) / EQ_W)
const yOfDb = (db: number): number => EQ_H / 2 - (Math.max(-EQ_RANGE * 1.5, Math.min(EQ_RANGE * 1.5, db)) / EQ_RANGE) * (EQ_H / 2)
const dbOfY = (y: number): number => ((EQ_H / 2 - y) / (EQ_H / 2)) * EQ_RANGE

function Num({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }): JSX.Element {
  return (
    <label className="st-num">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)))
        }}
      />
      <i>{unit}</i>
    </label>
  )
}

function StripEditor({
  s,
  cfg,
  onChange,
  reg,
  others,
  onCopyTo,
  onSavePreset,
  onDeletePreset
}: {
  s: Strip
  cfg: MixerConfig
  onChange: (p: Partial<Strip>) => void
  reg: (k: string) => (el: HTMLElement | null) => void
  others: Strip[]
  onCopyTo: (id: string) => void
  onSavePreset: (name: string) => void
  onDeletePreset: (id: string) => void
}): JSX.Element {
  const [band, setBand] = useState(1)
  const [presetName, setPresetName] = useState('')
  const response = useMemo(() => eqResponse(s, EQ_FREQS), [s])
  const drag = useRef<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  const setBandP = (i: number, p: Partial<EqBand>): void => onChange({ eq: { ...s.eq, bands: s.eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) } })

  const pointer = (e: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * EQ_W, y: ((e.clientY - r.top) / r.height) * EQ_H }
  }

  const path = response.map((db, i) => `${i ? 'L' : 'M'}${xOfF(EQ_FREQS[i]).toFixed(1)},${yOfDb(db).toFixed(1)}`).join(' ')
  const c = s.comp
  const compPts = Array.from({ length: 61 }, (_, i) => -60 + i).map((x) => [x, compressorCurve(x, c.thresholdDb, c.ratio, c.kneeDb) + c.makeupDb])

  return (
    <section className="st-panel st-editor" style={{ ['--strip' as string]: s.color }}>
      <header className="st-panel-head">
        <h2>
          Procesamiento · <span style={{ color: s.color }}>{s.name}</span>
        </h2>
        <div className="st-row">
          <select value="" onChange={(e) => e.target.value && onChange(applyPreset(s, e.target.value, cfg.userPresets))} title="Aplicar un preset de procesamiento">
            <option value="">Preset…</option>
            <optgroup label="De fábrica">
              {STRIP_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {cfg.userPresets.length > 0 && (
              <optgroup label="Míos">
                {cfg.userPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <input placeholder="Nombre del preset" value={presetName} onChange={(e) => setPresetName(e.target.value)} style={{ width: 140 }} />
          <button
            className="st-btn"
            onClick={() => {
              onSavePreset(presetName)
              setPresetName('')
            }}
            title="Guarda HPF, puerta, EQ, compresor, limitador y notches de esta entrada"
          >
            Guardar preset
          </button>
          {cfg.userPresets.length > 0 && (
            <select value="" onChange={(e) => e.target.value && confirm('¿Borrar ese preset?') && onDeletePreset(e.target.value)}>
              <option value="">Borrar preset…</option>
              {cfg.userPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <AutoTrimButton s={s} onTrim={(trimDb) => onChange({ trimDb })} />
          {others.length > 0 && (
            <select value="" onChange={(e) => e.target.value && onCopyTo(e.target.value)}>
              <option value="">Copiar procesamiento a…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="st-btn ghost"
            onClick={() =>
              confirm('¿Restablecer el procesamiento de esta entrada (EQ, filtro, puerta, compresor, limitador, notches, ducking)?') &&
              onChange({ ...createStrip(0, {}), id: s.id, name: s.name, color: s.color, input: s.input, sends: s.sends, faderDb: s.faderDb, pan: s.pan, trimDb: s.trimDb, cue: s.cue, mute: s.mute, solo: s.solo })
            }
          >
            Restablecer
          </button>
        </div>
      </header>

      <div className="st-editor-grid">
        <div className="st-editor-box">
          <div className="st-row">
            <b className="st-box-title">Ecualizador</b>
            <label className="st-inline">
              <input type="checkbox" checked={s.eq.on} onChange={(e) => onChange({ eq: { ...s.eq, on: e.target.checked } })} />
              Activo
            </label>
            <label className="st-inline">
              <input type="checkbox" checked={s.hpf.on} onChange={(e) => onChange({ hpf: { ...s.hpf, on: e.target.checked } })} />
              Paso alto
            </label>
            <input type="number" min={20} max={400} value={s.hpf.hz} onChange={(e) => onChange({ hpf: { ...s.hpf, hz: Math.min(400, Math.max(20, Number(e.target.value) || 80)) } })} />
            Hz
            <span className="st-grow" />
            <button className="st-btn ghost" onClick={() => onChange({ eq: { ...s.eq, bands: defaultEqBands() } })}>
              EQ plana
            </button>
          </div>
          <svg
            ref={svg}
            className="st-eq"
            viewBox={`0 0 ${EQ_W} ${EQ_H}`}
            onPointerMove={(e) => {
              if (drag.current === null) return
              const { x, y } = pointer(e)
              setBandP(drag.current, { freq: Math.round(fOfX(x)), gainDb: Math.round(Math.max(-EQ_RANGE, Math.min(EQ_RANGE, dbOfY(y))) * 2) / 2 })
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerLeave={() => (drag.current = null)}
            onWheel={(e) => {
              const b = s.eq.bands[band]
              if (b.type === 'peaking') setBandP(band, { q: Math.round(Math.max(0.2, Math.min(10, b.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) * 100) / 100 })
            }}
          >
            {[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => (
              <g key={f}>
                <line x1={xOfF(f)} x2={xOfF(f)} y1={0} y2={EQ_H} className="grid" />
                <text x={xOfF(f) + 2} y={EQ_H - 3}>
                  {f >= 1000 ? `${f / 1000}k` : f}
                </text>
              </g>
            ))}
            {[-12, -6, 0, 6, 12].map((d) => (
              <g key={d}>
                <line x1={0} x2={EQ_W} y1={yOfDb(d)} y2={yOfDb(d)} className={d === 0 ? 'zero' : 'grid'} />
                <text x={2} y={yOfDb(d) - 2}>
                  {d > 0 ? `+${d}` : d}
                </text>
              </g>
            ))}
            <path d={`${path} L${EQ_W},${EQ_H / 2} L0,${EQ_H / 2} Z`} className="fill" />
            <path d={path} className="curve" />
            {s.eq.bands.map((b, i) => (
              <g
                key={i}
                className={`handle ${band === i ? 'sel' : ''}`}
                onPointerDown={(e) => {
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  drag.current = i
                  setBand(i)
                }}
              >
                <circle cx={xOfF(b.freq)} cy={yOfDb(s.eq.on ? b.gainDb : 0)} r={9} />
                <text x={xOfF(b.freq)} y={yOfDb(s.eq.on ? b.gainDb : 0) + 4} textAnchor="middle">
                  {i + 1}
                </text>
              </g>
            ))}
          </svg>
          <p className="st-muted st-small">Arrastra los puntos (frecuencia y ganancia); rueda del ratón sobre el gráfico = ancho (Q) de la banda elegida.</p>
          <div className="st-bands-edit">
            {s.eq.bands.map((b, i) => (
              <div key={i} className={`st-band ${band === i ? 'sel' : ''}`} onClick={() => setBand(i)}>
                <div className="st-row">
                  <b>{i + 1}</b>
                  {i === 0 || i === 3 ? (
                    <select value={b.type} onChange={(e) => setBandP(i, { type: e.target.value as EqBand['type'] })}>
                      <option value={i === 0 ? 'lowshelf' : 'highshelf'}>{i === 0 ? 'Shelf graves' : 'Shelf agudos'}</option>
                      <option value="peaking">Campana</option>
                    </select>
                  ) : (
                    <span className="st-muted st-small">Campana</span>
                  )}
                </div>
                <Num label="Frec." value={b.freq} min={20} max={20000} unit="Hz" onChange={(freq) => setBandP(i, { freq })} />
                <Num label="Gan." value={b.gainDb} min={-18} max={18} step={0.5} unit="dB" onChange={(gainDb) => setBandP(i, { gainDb })} />
                {b.type === 'peaking' && <Num label="Q" value={b.q} min={0.2} max={10} step={0.05} unit="" onChange={(q) => setBandP(i, { q })} />}
              </div>
            ))}
          </div>
        </div>

        <div className="st-editor-box">
          <div className="st-row">
            <b className="st-box-title">Compresor</b>
            <label className="st-inline">
              <input type="checkbox" checked={c.on} onChange={(e) => onChange({ comp: { ...c, on: e.target.checked } })} />
              Activo
            </label>
            <Segmented<string>
              value=""
              onChange={(p) => {
                const presets: Record<string, Partial<Strip['comp']>> = {
                  voz: { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 120 },
                  suave: { thresholdDb: -24, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 250 },
                  fuerte: { thresholdDb: -12, ratio: 8, kneeDb: 2, attackMs: 3, releaseMs: 80 }
                }
                onChange({ comp: { ...c, ...presets[p], on: true } })
              }}
              options={[
                ['voz', 'Voz'],
                ['suave', 'Suave'],
                ['fuerte', 'Fuerte']
              ]}
              title="Ajustes rápidos"
            />
          </div>
          <div className="st-comp">
            <svg className="st-curve" viewBox="0 0 120 120">
              {[-48, -36, -24, -12].map((d) => (
                <g key={d}>
                  <line x1={((d + 60) / 60) * 120} x2={((d + 60) / 60) * 120} y1={0} y2={120} className="grid" />
                  <line y1={120 - ((d + 60) / 60) * 120} y2={120 - ((d + 60) / 60) * 120} x1={0} x2={120} className="grid" />
                </g>
              ))}
              <line x1={0} y1={120} x2={120} y2={0} className="zero" />
              <polyline points={compPts.map(([x, y]) => `${((x + 60) / 60) * 120},${120 - ((Math.max(-60, Math.min(0, y)) + 60) / 60) * 120}`).join(' ')} className="curve" />
            </svg>
            <div className="st-comp-params">
              <Num label="Umbral" value={c.thresholdDb} min={-60} max={0} unit="dB" onChange={(thresholdDb) => onChange({ comp: { ...c, thresholdDb } })} />
              <Num label="Ratio" value={c.ratio} min={1} max={20} step={0.5} unit=":1" onChange={(ratio) => onChange({ comp: { ...c, ratio } })} />
              <Num label="Rodilla" value={c.kneeDb} min={0} max={30} unit="dB" onChange={(kneeDb) => onChange({ comp: { ...c, kneeDb } })} />
              <Num label="Ataque" value={c.attackMs} min={0} max={200} unit="ms" onChange={(attackMs) => onChange({ comp: { ...c, attackMs } })} />
              <Num label="Liberación" value={c.releaseMs} min={10} max={1000} step={10} unit="ms" onChange={(releaseMs) => onChange({ comp: { ...c, releaseMs } })} />
              <Num label="Compens." value={c.makeupDb} min={0} max={24} step={0.5} unit="dB" onChange={(makeupDb) => onChange({ comp: { ...c, makeupDb } })} />
            </div>
          </div>

          <div className="st-row">
            <b className="st-box-title">Puerta de ruido</b>
            <label className="st-inline">
              <input type="checkbox" checked={s.gate.on} onChange={(e) => onChange({ gate: { ...s.gate, on: e.target.checked } })} />
              Activa
            </label>
            <span className="st-gate-led" ref={reg(`${s.id}:gateled`)} title="Encendido = abierta" />
          </div>
          <div className="st-comp-params">
            <Num label="Umbral" value={s.gate.thresholdDb} min={-90} max={0} unit="dB" onChange={(thresholdDb) => onChange({ gate: { ...s.gate, thresholdDb } })} />
            <Num label="Rango" value={s.gate.rangeDb} min={-90} max={0} unit="dB" onChange={(rangeDb) => onChange({ gate: { ...s.gate, rangeDb } })} />
            <Num label="Ataque" value={s.gate.attackMs} min={0.1} max={50} step={0.1} unit="ms" onChange={(attackMs) => onChange({ gate: { ...s.gate, attackMs } })} />
            <Num label="Mantener" value={s.gate.holdMs} min={0} max={1000} step={10} unit="ms" onChange={(holdMs) => onChange({ gate: { ...s.gate, holdMs } })} />
            <Num label="Liberación" value={s.gate.releaseMs} min={5} max={2000} step={5} unit="ms" onChange={(releaseMs) => onChange({ gate: { ...s.gate, releaseMs } })} />
          </div>

          <div className="st-row">
            <b className="st-box-title">Retardo</b>
          </div>
          <Num label="Alinear" value={s.delayMs} min={0} max={500} step={0.1} unit="ms" onChange={(delayMs) => onChange({ delayMs })} />
          <p className="st-muted st-small">
            Cadena: trim → polaridad → paso alto → notches → puerta → EQ → compresor → limitador → retardo → [pre-fader, CUE] → fader → ducking → panorama → envíos.
            Para alinear dos micros: ~2,9 ms por metro de diferencia de distancia.
          </p>
        </div>
      </div>

      <div className="st-editor-grid st-editor-grid-2">
        <div className="st-editor-box">
          <div className="st-row">
            <b className="st-box-title">Estructura de ganancia</b>
            <span className="st-muted st-small">pico de los últimos 3 s</span>
          </div>
          <div className="st-stages">
            {(
              [
                ['in', 'Entrada (tras trim)'],
                ['pre', 'Tras procesamiento'],
                ['post', 'Salida (tras fader)']
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="st-stage">
                <span>{label}</span>
                <div className="st-stage-bar">
                  <i ref={reg(`${s.id}:stage:${k}`)} />
                  {[-30, -18, -6].map((d) => (
                    <b key={d} style={{ left: `${((d - METER_MIN) / -METER_MIN) * 100}%` }} />
                  ))}
                </div>
                <code ref={reg(`${s.id}:stage:${k}:v`)}>—</code>
              </div>
            ))}
          </div>
          <p className="st-advice" ref={reg(`${s.id}:advice`)}>
            Enciende el mezclador para ver la ganancia.
          </p>

          <div className="st-row">
            <b className="st-box-title">Limitador del canal</b>
            <label className="st-inline">
              <input type="checkbox" checked={s.limiter.on} onChange={(e) => onChange({ limiter: { ...s.limiter, on: e.target.checked } })} />
              Activo
            </label>
            <span className="st-small st-muted">
              Reducción <code className="st-live" ref={reg(`${s.id}:limval`)}>—</code>
            </span>
          </div>
          <Num label="Techo" value={s.limiter.ceilingDb} min={-24} max={0} step={0.5} unit="dB" onChange={(ceilingDb) => onChange({ limiter: { ...s.limiter, ceilingDb } })} />

          <div className="st-row">
            <b className="st-box-title">Ducking</b>
            <label className="st-inline">
              <input type="checkbox" checked={s.duck.on} onChange={(e) => onChange({ duck: { ...s.duck, on: e.target.checked } })} />
              Activo
            </label>
            <select value={s.duck.sourceId ?? ''} onChange={(e) => onChange({ duck: { ...s.duck, sourceId: e.target.value || null } })} title="Entrada que hace bajar a esta">
              <option value="">Baja cuando suena…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <span className="st-small st-muted">
              Ahora <code className="st-live" ref={reg(`${s.id}:duckval`)}>—</code>
            </span>
          </div>
          <div className="st-comp-params">
            <Num label="Umbral" value={s.duck.thresholdDb} min={-80} max={0} unit="dB" onChange={(thresholdDb) => onChange({ duck: { ...s.duck, thresholdDb } })} />
            <Num label="Atenuar" value={s.duck.amountDb} min={-40} max={0} unit="dB" onChange={(amountDb) => onChange({ duck: { ...s.duck, amountDb } })} />
            <Num label="Ataque" value={s.duck.attackMs} min={1} max={500} unit="ms" onChange={(attackMs) => onChange({ duck: { ...s.duck, attackMs } })} />
            <Num label="Liberación" value={s.duck.releaseMs} min={20} max={3000} step={10} unit="ms" onChange={(releaseMs) => onChange({ duck: { ...s.duck, releaseMs } })} />
          </div>
          <p className="st-muted st-small">Ej.: en la música de fondo, elige el micro de voz: la música baja sola mientras alguien habla.</p>
        </div>

        <FeedbackBox s={s} onChange={onChange} />
      </div>
    </section>
  )
}

/** Feedback finder: watches the strip's pre-fader spectrum and proposes (or applies) notches */
function FeedbackBox({ s, onChange }: { s: Strip; onChange: (p: Partial<Strip>) => void }): JSX.Element {
  const state = useMixerState()
  const [live, setLive] = useState(false)
  const [auto, setAuto] = useState(false)
  const [found, setFound] = useState<FeedbackCandidate[]>([])
  const latest = useRef({ s, onChange, auto })
  latest.current = { s, onChange, auto }
  const running = live && state.status === 'on'

  useEffect(() => {
    setFound([])
    if (!running) return
    const det = new FeedbackDetector()
    const buf = new Float32Array(SPECTRUM_FFT / 2)
    const sr = state.sampleRate ?? 48000
    let shown = ''
    const id = setInterval(() => {
      const cur = latest.current
      if (!mixerEngine.stripSpectrum(cur.s.id, buf)) return
      const c = det.push(buf, sr, SPECTRUM_FFT, performance.now())
      const key = c.map((x) => x.hz).join(',')
      if (key !== shown) {
        shown = key
        setFound(c)
      }
      if (!cur.auto) return
      let notches = cur.s.notches
      for (const x of c) notches = addNotch(notches, x.hz, MAX_NOTCHES)
      if (notches !== cur.s.notches) {
        cur.onChange({ notches })
        latest.current = { ...cur, s: { ...cur.s, notches } }
      }
    }, 100)
    return () => clearInterval(id)
  }, [running, state.sampleRate, s.id])

  const setNotch = (i: number, p: Partial<Strip['notches'][number]>): void => onChange({ notches: s.notches.map((n, j) => (j === i ? { ...n, ...p } : n)) })

  return (
    <div className="st-editor-box">
      <div className="st-row">
        <b className="st-box-title">Anti-acople</b>
        <button className={`st-btn ${live ? 'on' : ''}`} disabled={state.status !== 'on'} onClick={() => setLive((v) => !v)}>
          {live ? 'Detectando…' : 'Detectar acople'}
        </button>
        <label className="st-inline" title="Corta automáticamente cada acople que detecte">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Automático
        </label>
        <span className="st-grow" />
        <button className="st-btn ghost" disabled={s.notches.length >= MAX_NOTCHES} onClick={() => onChange({ notches: [...s.notches, { hz: 1000, gainDb: -12, q: 30 }] })}>
          + Notch
        </button>
      </div>
      {running && (
        <div className="st-feedback">
          {found.length === 0 ? (
            <span className="st-muted st-small">Sin acoples. Sube poco a poco el fader o el volumen de los altavoces hasta que empiece a pitar.</span>
          ) : (
            found.map((f) => (
              <div key={f.hz} className="st-feedback-hit">
                <b>{f.hz} Hz</b>
                <span className="st-small">
                  +{f.prominenceDb} dB sobre el resto · {(f.sustainedMs / 1000).toFixed(1)} s
                </span>
                <button className="st-btn" disabled={s.notches.length >= MAX_NOTCHES && !s.notches.some((n) => Math.abs(n.hz - f.hz) < 5)} onClick={() => onChange({ notches: addNotch(s.notches, f.hz, MAX_NOTCHES) })}>
                  Cortar
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {s.notches.length === 0 ? (
        <p className="st-muted st-small">Sin notches. Un notch es un corte muy estrecho (Q 30) que quita el pitido sin cambiar cómo suena la voz.</p>
      ) : (
        <div className="st-notches">
          {s.notches.map((n, i) => (
            <div key={i} className="st-notch">
              <Num label={`${i + 1} · Frec.`} value={n.hz} min={40} max={16000} unit="Hz" onChange={(hz) => setNotch(i, { hz })} />
              <Num label="Corte" value={n.gainDb} min={-30} max={0} step={0.5} unit="dB" onChange={(gainDb) => setNotch(i, { gainDb })} />
              <Num label="Q" value={n.q} min={2} max={60} unit="" onChange={(q) => setNotch(i, { q })} />
              <button className="st-x" onClick={() => onChange({ notches: s.notches.filter((_, j) => j !== i) })} title="Quitar notch">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {s.notches.length > 0 && (
        <button className="st-btn ghost" onClick={() => confirm('¿Quitar todos los notches de esta entrada?') && onChange({ notches: [] })}>
          Quitar todos
        </button>
      )}
    </div>
  )
}

/** Headphone/cue output section */
function MonitorRow({
  monitor,
  buses,
  outputs,
  cued,
  onChange,
  onClearCue
}: {
  monitor: Monitor
  buses: Bus[]
  outputs: MediaDeviceInfo[]
  cued: Strip[]
  onChange: (p: Partial<Monitor>) => void
  onClearCue: () => void
}): JSX.Element {
  return (
    <div className="st-row st-mon-row">
      <b className="st-box-title">🎧 Monitor</b>
      <label className="st-inline" title="Salida de auriculares independiente de los buses">
        <input type="checkbox" checked={monitor.on} onChange={(e) => onChange({ on: e.target.checked })} />
        Activo
      </label>
      <select value={monitor.deviceId ?? ''} onChange={(e) => onChange({ deviceId: e.target.value || null })} title="Auriculares">
        <option value="">Salida predeterminada</option>
        {outputs.map((o, i) => (
          <option key={o.deviceId} value={o.deviceId}>
            {o.label || `Salida ${i + 1}`}
          </option>
        ))}
      </select>
      <label className="st-inline">
        Escuchar
        <select value={monitor.source} onChange={(e) => onChange({ source: e.target.value })} title="Bus que suena en el monitor cuando no hay ningún CUE">
          {buses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label} · {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="st-inline st-mon-level">
        Nivel
        <input type="range" min={-60} max={6} step={0.5} value={monitor.levelDb} onChange={(e) => onChange({ levelDb: Number(e.target.value) })} onDoubleClick={() => onChange({ levelDb: 0 })} />
        <code>{monitor.levelDb <= FADER_MIN ? '-∞' : `${monitor.levelDb > 0 ? '+' : ''}${monitor.levelDb} dB`}</code>
      </label>
      {cued.length > 0 && (
        <button className="st-cue-active" onClick={onClearCue} title="Quitar todos los CUE">
          CUE: {cued.map((s) => s.name).join(', ')} ×
        </button>
      )}
    </div>
  )
}

const MIDI_STRIP_KINDS: [MidiTargetKind, string][] = [
  ['stripFader', 'Fader'],
  ['stripPan', 'Panorama'],
  ['stripMute', 'Mute'],
  ['stripSolo', 'Solo'],
  ['stripCue', 'CUE']
]
const MIDI_BUS_KINDS: [MidiTargetKind, string][] = [
  ['busFader', 'Fader'],
  ['busMute', 'Mute']
]

function MidiPanel({ cfg, midi, onRemove }: { cfg: MixerConfig; midi: ReturnType<typeof useMidi>; onRemove: (key: string) => void }): JSX.Element {
  const [target, setTarget] = useState('')
  const targets: { value: string; label: string }[] = [
    ...cfg.strips.flatMap((s) => MIDI_STRIP_KINDS.map(([k, l]) => ({ value: `${k}|${s.id}`, label: `${s.name} · ${l}` }))),
    ...cfg.buses.flatMap((b) => MIDI_BUS_KINDS.map(([k, l]) => ({ value: `${k}|${b.id}`, label: `Bus ${b.label} · ${l}` })))
  ]
  const nameOf = (kind: MidiTargetKind, id: string): string => targets.find((t) => t.value === `${kind}|${id}`)?.label ?? '(entrada borrada)'
  return (
    <div className="st-midi">
      <div className="st-row">
        <b className="st-box-title">Controlador MIDI</b>
        <span className="st-small st-muted">{midi.error || (midi.inputs.length ? `Conectado: ${midi.inputs.join(', ')}` : 'No hay controladores MIDI conectados.')}</span>
      </div>
      <div className="st-row">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Elige qué controlar…</option>
          {targets.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {midi.learn ? (
          <button className="st-btn on" onClick={() => midi.setLearn(null)}>
            Mueve un fader o pulsa un botón… (cancelar)
          </button>
        ) : (
          <button
            className="st-btn"
            disabled={!target || midi.inputs.length === 0}
            onClick={() => {
              const [kind, id] = target.split('|') as [MidiTargetKind, string]
              midi.setLearn({ kind, id })
            }}
          >
            Aprender
          </button>
        )}
      </div>
      {cfg.midi.length > 0 && (
        <ul className="st-midi-list">
          {cfg.midi.map((m) => (
            <li key={m.key}>
              <code>{describeMidiKey(m.key)}</code> → {nameOf(m.kind, m.id)}
              <button className="st-x" onClick={() => onRemove(m.key)} title="Quitar">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

