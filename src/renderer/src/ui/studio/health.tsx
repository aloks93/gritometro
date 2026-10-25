import { useEffect, useRef, useState } from 'react'
import { activeProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { mixerEngine } from '../../core/audio/MixerEngine'
import { routingWarnings } from '../../core/mixer/mixer'
import { calibrationWarnings } from '../../core/studio/calibration'
import {
  alarmsOf,
  deviceChanges,
  evaluateHealth,
  LevelTracker,
  STATUS_LABEL,
  STATUS_RANK,
  worstStatus,
  type HealthGroup,
  type HealthItem,
  type HealthStatus
} from '../../core/studio/health'
import { useEngineState } from '../hooks'
import { useStore } from '../store'
import { generator } from './generator'
import { useLoudness } from './meters'
import { useMixerState } from './MixerView'
import { fitCanvas, fmtDb } from './widgets'
import './health.css'

type DeviceEvent = { t: number; text: string; kind: 'added' | 'removed' }

/** Re-evaluates the studio's health 4×/s from the live engines */
export function useHealth(): HealthItem[] {
  const { data } = useStore()
  const engine = useEngineState()
  const mixer = useMixerState()
  const [items, setItems] = useState<HealthItem[]>([])
  const [events, setEvents] = useState<DeviceEvent[]>([])
  const input = useRef(new LevelTracker())
  const strips = useRef(new Map<string, LevelTracker>())
  const buses = useRef(new Map<string, LevelTracker>())
  const rms = useRef(-100)
  const latest = useRef({ data, engine, mixer, events })
  latest.current = { data, engine, mixer, events }

  useEffect(
    () =>
      audioEngine.onReading((r) => {
        input.current.push(r.t, r.peakDb, r.clipped)
        rms.current = r.smoothedDb
      }),
    []
  )

  // Hot-plug: compare input device labels on every change
  useEffect(() => {
    let labels: string[] | null = null
    const read = (): void => {
      navigator.mediaDevices
        ?.enumerateDevices()
        .then((d) => {
          const now = d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x) => x.label || x.deviceId)
          if (labels) {
            const changes = deviceChanges(labels, now, performance.now())
            if (changes.length) setEvents((ev) => [...ev, ...changes].slice(-10))
          }
          labels = now
        })
        .catch(() => undefined)
    }
    read()
    navigator.mediaDevices?.addEventListener('devicechange', read)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', read)
  }, [])

  const track = (map: Map<string, LevelTracker>, key: string): LevelTracker => {
    let t = map.get(key)
    if (!t) map.set(key, (t = new LevelTracker()))
    return t
  }

  // Mixer levels every frame: a 4×/s poll of a 21 ms window would miss short peaks
  useEffect(() => {
    let raf = 0
    const sample = (): void => {
      raf = requestAnimationFrame(sample)
      if (!mixerEngine.running) {
        strips.current.clear()
        buses.current.clear()
        return
      }
      const now = performance.now()
      const cfg = latest.current.data.mixer
      for (const s of cfg.strips) {
        const l = mixerEngine.stripLevel(s.id)
        if (l) track(strips.current, s.id).push(now, l.inPeak)
      }
      for (const b of cfg.buses) {
        const l = mixerEngine.busLevel(b.id)
        if (l) track(buses.current, b.id).push(now, Math.max(l.peakL, l.peakR))
      }
    }
    sample()
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const { data, engine, mixer, events } = latest.current
      const now = performance.now()
      const p = activeProfile(data.audio)
      const cfg = data.mixer
      const on = mixer.status === 'on'
      const lat = audioEngine.reportedLatency()
      const cal = data.studio.calibrations[p.id]?.find((h) => h.method !== 'loopback')
      const result = evaluateHealth({
        now,
        engine,
        input: input.current.window(now),
        noiseFloorDb: p.noiseFloorDb,
        rmsDb: engine.status === 'running' ? rms.current : -100,
        splOffset: p.splOffset,
        overSplDb: data.studio.prefs.alarmSplDb,
        latencyMs: lat ? lat.baseMs + lat.outputMs : null,
        calibrationWarnings: calibrationWarnings(cal, { deviceLabel: engine.status === 'running' ? engine.label : undefined, gainDb: p.gainDb, offsetDb: p.splOffset }),
        mixer:
          mixer.status === 'off'
            ? null
            : {
                status: mixer.status,
                error: mixer.error,
                stripErrors: mixer.stripErrors,
                strips: cfg.strips.map((s) => ({ id: s.id, name: s.name, muted: s.mute, level: track(strips.current, s.id).window(now) })),
                buses: cfg.buses.map((b) => ({ id: b.id, label: b.label, name: b.name, limitingDb: on ? (mixerEngine.busLevel(b.id)?.gr ?? 0) : 0, level: track(buses.current, b.id).window(now) }))
              },
        routingWarnings: on ? routingWarnings(cfg).map((w) => w.message) : [],
        generatorRunning: !!generator.running,
        monitorOn: data.studio.prefs.monitorDb !== null,
        deviceEvents: events
      })
      setItems((prev) => (JSON.stringify(prev) === JSON.stringify(result) ? prev : result))
    }, 250)
    return () => clearInterval(id)
  }, [])

  return items
}

const GROUPS: [HealthGroup, string][] = [
  ['entrada', 'Entrada'],
  ['mezclador', 'Mezclador'],
  ['medida', 'Medida'],
  ['sistema', 'Sistema']
]

/** Topbar: one LED per group plus the overall state; click opens the panel */
export function HealthButton({ items, onClick, open }: { items: HealthItem[]; onClick: () => void; open: boolean }): JSX.Element {
  const worst = worstStatus(items)
  const issues = items.filter((i) => STATUS_RANK[i.status] >= STATUS_RANK.warning).length
  return (
    <button className={`st-health-btn ${open ? 'open' : ''}`} onClick={onClick} title="Estado del sistema">
      {GROUPS.map(([g, label]) => {
        const gi = items.filter((i) => i.group === g)
        return <i key={g} className={`st-led ${gi.length ? worstStatus(gi) : 'off'}`} title={`${label}: ${gi.length ? STATUS_LABEL[worstStatus(gi)] : '—'}`} />
      })}
      <span className={`st-health-label ${worst}`}>{issues ? `${issues} aviso${issues > 1 ? 's' : ''}` : 'Todo OK'}</span>
    </button>
  )
}

export function HealthPanel({ items, onClose }: { items: HealthItem[]; onClose: () => void }): JSX.Element {
  return (
    <aside className="st-health-panel">
      <header className="st-panel-head">
        <h2>Estado del sistema</h2>
        <button className="st-btn ghost" onClick={onClose}>
          ✕
        </button>
      </header>
      {GROUPS.map(([g, label]) => {
        const gi = items.filter((i) => i.group === g).sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])
        if (gi.length === 0) return null
        return (
          <section key={g}>
            <h3>{label}</h3>
            <ul>
              {gi.map((i) => (
                <li key={i.id}>
                  <span className={`st-chip ${i.status}`}>{STATUS_LABEL[i.status]}</span>
                  <div>
                    <b>{i.label}</b>
                    <small>{i.detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <p className="st-muted st-small">Verde = OK · ámbar = aviso · azul = silencio · violeta = exceso de nivel · rojo = CLIP o fallo · gris = apagado.</p>
    </aside>
  )
}

/** Banner over everything while something clips, is too loud or got disconnected */
export function AlarmBanner({ items }: { items: HealthItem[] }): JSX.Element | null {
  const [mutedUntil, setMutedUntil] = useState(0)
  const held = useRef(new Map<string, { item: HealthItem; seen: number }>())
  const [, tick] = useState(0)
  const now = performance.now()
  for (const a of alarmsOf(items)) held.current.set(a.id, { item: a, seen: now })
  // Keep an alarm up 2 s after it ends so a short clip can still be read
  for (const [id, h] of held.current) if (now - h.seen > 2000) held.current.delete(id)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  const list = [...held.current.values()].map((h) => h.item)
  if (list.length === 0 || now < mutedUntil) return null
  const clip = list.some((a) => a.status === 'clip')
  return (
    <div className={`st-alarm ${clip ? 'clip' : 'over'}`} role="alert">
      <b>{clip ? '⚠ CLIP' : '⚠ NIVEL'}</b>
      <span>
        {list
          .slice(0, 3)
          .map((a) => `${a.label}: ${a.detail}`)
          .join('  ·  ')}
        {list.length > 3 ? `  · +${list.length - 3}` : ''}
      </span>
      <button className="st-btn ghost" onClick={() => setMutedUntil(performance.now() + 30000)}>
        Silenciar 30 s
      </button>
    </div>
  )
}

// ---- Stage view: big meters readable from across the room

const STAGE_MIN = -60

export function StageView({ items }: { items: HealthItem[] }): JSX.Element {
  const { data } = useStore()
  const engine = useEngineState()
  const mixer = useMixerState()
  const { reading: loud } = useLoudness()
  const profile = activeProfile(data.audio)
  const [spl, setSpl] = useState<number | null>(null)
  const refs = useRef(new Map<string, HTMLElement>())
  const reg = (k: string) => (el: HTMLElement | null) => {
    if (el) refs.current.set(k, el)
    else refs.current.delete(k)
  }
  const statusOf = (id: string): HealthStatus => items.find((i) => i.id === id)?.status ?? 'off'
  const on = mixer.status === 'on'

  useEffect(() => {
    let raf = 0
    let frame = 0
    const holds = new Map<string, { db: number; t: number }>()
    const set = (k: string, db: number): void => {
      const el = refs.current.get(k)
      if (!el) return
      const pct = Math.max(0, Math.min(1, (db - STAGE_MIN) / -STAGE_MIN))
      el.style.transform = `scaleY(${pct})`
      const now = performance.now()
      const h = holds.get(k)
      const v = !h || db > h.db || now - h.t > 1500 ? { db, t: now } : h
      holds.set(k, v)
      const hold = refs.current.get(`${k}:hold`)
      if (hold) {
        // The line is 3 px tall: keep it inside the track at full scale
        const p = Math.max(0, Math.min(1, (v.db - STAGE_MIN) / -STAGE_MIN)) * 100
        hold.style.bottom = `calc(${p}% - ${((3 * p) / 100).toFixed(1)}px)`
        hold.classList.toggle('clip', v.db > -0.5)
      }
      const txt = refs.current.get(`${k}:v`)
      if (txt) txt.textContent = fmtDb(v.db)
    }
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const r = audioEngine.last
      if (r) set('input', r.peakDb)
      if (++frame % 15 === 0 && r) setSpl(r.smoothedDb > -90 ? Math.round(r.smoothedDb + profile.splOffset) : null)
      if (!mixerEngine.running) return
      for (const s of data.mixer.strips) {
        const l = mixerEngine.stripLevel(s.id)
        if (l) set(`strip-${s.id}`, Math.max(l.peakL, l.peakR))
      }
      for (const b of data.mixer.buses) {
        const l = mixerEngine.busLevel(b.id)
        if (l) set(`bus-${b.id}`, Math.max(l.peakL, l.peakR))
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [data.mixer, profile.splOffset])

  const meter = (key: string, name: string, status: HealthStatus, sub?: string): JSX.Element => (
    <div key={key} className={`st-stage-meter ${status}`}>
      <div className="st-stage-track">
        <i ref={reg(key)} />
        <b ref={reg(`${key}:hold`)} />
        {[-6, -18, -30, -48].map((d) => (
          <span key={d} style={{ bottom: `${((d - STAGE_MIN) / -STAGE_MIN) * 100}%` }}>
            {d}
          </span>
        ))}
      </div>
      <code ref={reg(`${key}:v`)}>-∞</code>
      <strong>{name}</strong>
      {sub && <small>{sub}</small>}
      <em>{STATUS_LABEL[status]}</em>
    </div>
  )

  const worst = worstStatus(items)
  return (
    <div className="st-stage">
      <div className="st-stage-head">
        <div className={`st-stage-big ${statusOf('spl')}`}>
          <small>SPL aprox.</small>
          <b>{spl !== null && engine.status === 'running' ? spl : '—'}</b>
          <i>dB</i>
        </div>
        <div className="st-stage-big">
          <small>LUFS corto plazo</small>
          <b>{loud && loud.shortTerm > -70 ? loud.shortTerm.toFixed(1) : '—'}</b>
          <i>LUFS</i>
        </div>
        <div className="st-stage-big">
          <small>LUFS integrada</small>
          <b>{loud && loud.integrated > -70 ? loud.integrated.toFixed(1) : '—'}</b>
          <i>LUFS</i>
        </div>
        <div className={`st-stage-big ${worst}`}>
          <small>Estado</small>
          <b className="st-stage-state">{STATUS_LABEL[worst]}</b>
          <i>{items.filter((i) => STATUS_RANK[i.status] >= STATUS_RANK.warning).length} avisos</i>
        </div>
      </div>
      <div className="st-stage-meters">
        {meter('input', 'Entrada', statusOf('level'), engine.status === 'running' ? engine.label : 'Sin señal')}
        {on && <div className="st-stage-sep" />}
        {on && data.mixer.strips.map((s) => meter(`strip-${s.id}`, s.name, statusOf(`strip-${s.id}`), s.mute ? 'MUTE' : undefined))}
        {on && <div className="st-stage-sep" />}
        {on && data.mixer.buses.filter((b) => !b.mute).map((b) => meter(`bus-${b.id}`, `Bus ${b.label}`, statusOf(`bus-${b.id}`) === 'off' ? 'ok' : statusOf(`bus-${b.id}`), b.name))}
      </div>
      <StageScope />
    </div>
  )
}

/** Wide waveform strip under the meters */
function StageScope(): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const d = audioEngine.waveform()
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      g.clearRect(0, 0, w, h)
      if (!d) return
      g.strokeStyle = getComputedStyle(c).getPropertyValue('--st-ok')
      g.lineWidth = 2 * devicePixelRatio
      g.beginPath()
      for (let i = 0; i < d.length; i++) {
        const x = (i / (d.length - 1)) * w
        const y = h / 2 - d[i] * (h / 2)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="st-canvas st-stage-scope" />
}
