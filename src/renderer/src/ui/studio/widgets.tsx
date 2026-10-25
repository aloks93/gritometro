import { useEffect, useRef, useState } from 'react'
import { MIN_DB } from '../../core/audio/LevelAnalyzer'

// Small building blocks shared by the studio views.

export function useInterval(fn: () => void, ms: number, enabled = true): void {
  const saved = useRef(fn)
  saved.current = fn
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => saved.current(), ms)
    return () => clearInterval(t)
  }, [ms, enabled])
}

/** Re-renders at most every `ms` with the latest value of `read()` (meters don't need 60 fps of React) */
export function usePolled<T>(read: () => T, ms = 100): T {
  const [value, setValue] = useState(read)
  useInterval(() => setValue(read()), ms)
  return value
}

/** Resizes the backing store only when the element size changes (resizing every frame reallocates it) */
export function fitCanvas(c: HTMLCanvasElement): [number, number] {
  const w = Math.round(c.clientWidth * devicePixelRatio)
  const h = Math.round(c.clientHeight * devicePixelRatio)
  if (c.width !== w) c.width = w
  if (c.height !== h) c.height = h
  return [w, h]
}

export function fmtDb(v: number, digits = 1, floor = MIN_DB): string {
  return !Number.isFinite(v) || v <= floor ? '-∞' : v.toFixed(digits)
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`
}

const DEFAULT_MIN = -60

/** Segmented horizontal meter with peak hold, studio style */
export function BarMeter({
  label,
  db,
  hold,
  min = DEFAULT_MIN,
  max = 0
}: {
  label: string
  db: number
  hold: number
  min?: number
  max?: number
}): JSX.Element {
  const pct = (v: number): number => Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))
  return (
    <div className="st-meter">
      <span className="st-meter-label">{label}</span>
      <div className="st-meter-track">
        <div className="st-meter-fill" style={{ clipPath: `inset(0 ${100 - pct(db)}% 0 0)` }} />
        <div className="st-meter-hold" style={{ left: `${pct(hold)}%` }} />
      </div>
      <span className="st-meter-value">{fmtDb(db)}</span>
    </div>
  )
}

export function MeterScale({ marks, min = DEFAULT_MIN, max = 0, unit = 'dBFS' }: { marks: number[]; min?: number; max?: number; unit?: string }): JSX.Element {
  const pct = (v: number): number => ((v - min) / (max - min)) * 100
  return (
    <div className="st-meter st-scale">
      <span className="st-meter-label" />
      <div className="st-meter-track st-scale-track">
        {marks.map((d) => (
          <span key={d} style={{ left: `${pct(d)}%` }}>
            {d}
          </span>
        ))}
      </div>
      <span className="st-meter-value">{unit}</span>
    </div>
  )
}

export function Readout({
  label,
  value,
  unit,
  tone,
  onReset,
  big
}: {
  label: string
  value: string
  unit: string
  tone?: 'ok' | 'warn' | 'bad' | ''
  onReset?: () => void
  big?: boolean
}): JSX.Element {
  return (
    <div className={`st-readout ${tone ?? ''} ${big ? 'big' : ''}`}>
      <small>
        {label}
        {onReset && (
          <button className="st-reset" onClick={onReset} title="Reiniciar">
            ↺
          </button>
        )}
      </small>
      <b>
        {value} <i>{unit}</i>
      </b>
    </div>
  )
}

/** Segmented control (radio buttons styled as a button group) */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  title
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  title?: string
}): JSX.Element {
  return (
    <div className="st-seg" title={title}>
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** Slider + number box for one parameter */
export function Num({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void }): JSX.Element {
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
