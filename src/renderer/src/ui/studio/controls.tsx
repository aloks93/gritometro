import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// Hardware-style controls for the mic processor: rotary knob, switch, vertical meter and a
// small SVG icon set (no emoji, so it renders the same everywhere).

const ARC = 135

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`
}

export interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  /** Double-click resets to this */
  def?: number
  /** Logarithmic travel (frequencies, times) */
  log?: boolean
  /** Arc grows from this value (e.g. 0 dB for gains) instead of from the minimum */
  center?: number
  disabled?: boolean
  size?: number
  format?: (v: number) => string
  onChange: (v: number) => void
}

/**
 * Rotary knob: drag up/down (Shift = fine), mouse wheel, double-click = default.
 * The value under it can be typed in directly.
 */
export function Knob({ label, value, min, max, step = 1, unit = '', def, log, center, disabled, size = 48, format, onChange }: KnobProps): JSX.Element {
  const toNorm = (v: number): number => {
    const c = Math.max(min, Math.min(max, v))
    return log ? Math.log(c / min) / Math.log(max / min) : (c - min) / (max - min)
  }
  const fromNorm = (n: number): number => {
    const t = Math.max(0, Math.min(1, n))
    const v = log ? min * Math.pow(max / min, t) : min + t * (max - min)
    const s = log && v >= 1000 && step < 10 ? 10 : step
    return Math.max(min, Math.min(max, Math.round(v / s) * s))
  }
  const drag = useRef<{ y: number; n: number } | null>(null)
  const [text, setText] = useState<string | null>(null)
  const n = toNorm(value)
  const deg = -ARC + n * ARC * 2
  const from = center !== undefined ? -ARC + toNorm(center) * ARC * 2 : -ARC
  const r = size / 2 - 4
  const c = size / 2
  const shown = format ? format(value) : fmtNum(value, step)
  const commit = (raw: string): void => {
    const v = Number(raw.replace(',', '.'))
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)))
    setText(null)
  }
  return (
    <div className={`vp-knob ${disabled ? 'disabled' : ''}`} style={{ width: size + 24 }}>
      <span className="vp-knob-label">{label}</span>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        onPointerDown={(e) => {
          if (disabled) return
          ;(e.target as Element).setPointerCapture?.(e.pointerId)
          drag.current = { y: e.clientY, n }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const k = e.shiftKey ? 0.15 : 1
          onChange(fromNorm(d.n + ((d.y - e.clientY) / 160) * k))
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => !disabled && def !== undefined && onChange(def)}
        onWheel={(e) => {
          if (disabled) return
          const k = e.shiftKey ? 0.002 : 0.02
          onChange(fromNorm(n + (e.deltaY < 0 ? k : -k)))
        }}
      >
        <path d={arcPath(c, c, r, -ARC, ARC)} className="vp-knob-track" />
        {Math.abs(deg - from) > 0.5 && <path d={arcPath(c, c, r, Math.min(from, deg), Math.max(from, deg))} className="vp-knob-value" />}
        <circle cx={c} cy={c} r={r - 6} className="vp-knob-cap" />
        <line x1={polar(c, c, r - 16, deg)[0]} y1={polar(c, c, r - 16, deg)[1]} x2={polar(c, c, r - 7, deg)[0]} y2={polar(c, c, r - 7, deg)[1]} className="vp-knob-pointer" />
      </svg>
      <input
        className="vp-knob-value-text"
        value={text ?? (unit && /\d/.test(shown) ? `${shown} ${unit}` : shown)}
        disabled={disabled}
        onFocus={(e) => {
          setText(String(value))
          requestAnimationFrame(() => e.target.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </div>
  )
}

export function fmtNum(v: number, step = 1): string {
  if (Math.abs(v) >= 1000 && step >= 1) return v >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${(v / 1000).toFixed(2)}k`
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return v.toFixed(digits)
}

/** On/off switch styled like a hardware bypass button */
export function Switch({ on, onChange, labels = ['ON', 'OFF'], title }: { on: boolean; onChange: (on: boolean) => void; labels?: [string, string]; title?: string }): JSX.Element {
  return (
    <button className={`vp-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={title} aria-pressed={on}>
      <i />
      {on ? labels[0] : labels[1]}
    </button>
  )
}

const METER_MIN = -60

/** Vertical peak/RMS meter with peak hold and clip LED; values in dBFS */
export function VMeter({ peak, rms, hold, label, clip }: { peak: number; rms: number; hold: number; label: string; clip: boolean }): JSX.Element {
  const pct = (db: number): number => Math.max(0, Math.min(100, ((db - METER_MIN) / -METER_MIN) * 100))
  return (
    <div className="vp-vmeter">
      <span className={`vp-clip ${clip ? 'on' : ''}`}>CLIP</span>
      <div className="vp-vmeter-body">
        <div className="vp-vmeter-scale">
          {[0, -6, -12, -18, -24, -36, -48, -60].map((d) => (
            <span key={d} style={{ bottom: `${pct(d)}%` }}>
              {d}
            </span>
          ))}
        </div>
        <div className="vp-vmeter-track">
          <div className="vp-vmeter-fill" style={{ clipPath: `inset(${100 - pct(peak)}% 0 0 0)` }} />
          <div className="vp-vmeter-rms" style={{ height: `${pct(rms)}%` }} />
          <div className="vp-vmeter-hold" style={{ bottom: `${pct(hold)}%` }} />
        </div>
      </div>
      <b className="vp-vmeter-label">{label}</b>
    </div>
  )
}

/** Peak hold that falls back after `ms` */
export function useHold(v: number, ms = 1500): number {
  const h = useRef({ v: -100, t: 0 })
  const now = performance.now()
  if (v > h.current.v || now - h.current.t > ms) h.current = { v, t: now }
  return h.current.v
}

/** Re-renders on every animation frame while mounted (for small live widgets) */
export function useFrame(fps = 30): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    let raf = 0
    let last = 0
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      if (now - last >= 1000 / fps) {
        last = now
        setT(now)
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [fps])
  return t
}

// ---- Icons (24×24, stroke = currentColor)

const ICONS: Record<string, ReactNode> = {
  power: (
    <>
      <path d="M12 3v8" />
      <path d="M6.3 6.8a8 8 0 1 0 11.4 0" />
    </>
  ),
  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2.5 20h19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.2v.3" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  wand: (
    <>
      <path d="M4 20 15 9" />
      <path d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M12 4v1.5M11.25 4.75h1.5" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7V4" />
      <rect x="8" y="13" width="8" height="5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v4h16v-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 16v4h16v-4" />
    </>
  ),
  reset: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4h4" />
    </>
  ),
  record: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
      <path d="M12 17v.3" />
    </>
  ),
  fullscreen: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    </>
  )
}

export function Icon({ name, size = 16, style }: { name: keyof typeof ICONS | string; size?: number; style?: CSSProperties }): JSX.Element {
  return (
    <svg className="vp-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden>
      {ICONS[name]}
    </svg>
  )
}
