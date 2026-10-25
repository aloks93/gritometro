import type { RevealProps } from '../Theme'

/** The result appears behind a closet door that swings open */
export function DoorReveal({ children }: RevealProps): JSX.Element {
  return (
    <div className="door-reveal">
      <div className="door-reveal-content">{children}</div>
      <div className="door-reveal-panel">
        <span className="door-window" />
        <span className="door-knob" />
      </div>
    </div>
  )
}
