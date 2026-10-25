import type { MeterProps, RevealProps } from '../../themes/Theme'
import { useStore } from '../store'

/** Generic vertical bar meter used when a theme doesn't provide its own */
export function BarMeter({ level, held, active, score, clipped, compact }: MeterProps): JSX.Element {
  return (
    <div className={`bar-meter ${compact ? 'compact' : ''} ${active ? 'active' : ''}`}>
      <div className="bar-meter-track">
        <div className="bar-meter-fill" style={{ transform: `scaleY(${level})` }} />
        {held > 0.01 && <div className="bar-meter-held" style={{ bottom: `${held * 100}%` }} />}
        {[25, 50, 75].map((p) => (
          <div key={p} className="bar-meter-tick" style={{ bottom: `${p}%` }} />
        ))}
      </div>
      <div className={`bar-meter-clip ${clipped ? 'on' : ''}`}>CLIP</div>
      {score != null && <div className="bar-meter-score">{Math.round(score)}</div>}
    </div>
  )
}

/** Picks the active theme's meter component */
export function Meter(props: MeterProps): JSX.Element {
  const { theme } = useStore()
  const Component = theme.components.Meter ?? BarMeter
  return <Component {...props} />
}

function PopReveal({ children }: RevealProps): JSX.Element {
  return <div className="pop-reveal">{children}</div>
}

export function Reveal({ children }: RevealProps): JSX.Element {
  const { theme } = useStore()
  const Component = theme.components.Reveal ?? PopReveal
  return <Component>{children}</Component>
}

export function AppBackground(): JSX.Element {
  const { theme } = useStore()
  if (theme.images.background) {
    return <div className="app-bg-image" style={{ backgroundImage: `url(${theme.images.background})` }} />
  }
  const Background = theme.components.Background
  return Background ? <Background /> : <div className="app-bg-default" />
}
