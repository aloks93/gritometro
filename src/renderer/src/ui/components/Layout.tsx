import type { ReactNode } from 'react'

export function Screen({
  title,
  onBack,
  actions,
  children,
  className = ''
}: {
  title?: string
  onBack?: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={`screen ${className}`}>
      {(title || onBack || actions) && (
        <header className="screen-header">
          {onBack && (
            <button className="btn ghost" onClick={onBack}>
              ← Volver
            </button>
          )}
          {title && <h1 className="screen-title">{title}</h1>}
          <div className="screen-actions">{actions}</div>
        </header>
      )}
      <div className="screen-body">{children}</div>
    </div>
  )
}

export function Panel({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }): JSX.Element {
  return (
    <section className={`panel ${className}`}>
      {title && <h2 className="panel-title">{title}</h2>}
      {children}
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v)
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}): JSX.Element {
  return (
    <div className="slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format(value)}</output>
    </div>
  )
}
