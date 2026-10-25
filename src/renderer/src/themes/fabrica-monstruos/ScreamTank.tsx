import { useId } from 'react'
import type { MeterProps } from '../Theme'

const TOP = 60
const BOTTOM = 350
const HEIGHT = BOTTOM - TOP

const BUBBLES = [
  { x: 80, r: 5, d: 1.6, delay: 0 },
  { x: 120, r: 3, d: 1.2, delay: 0.4 },
  { x: 100, r: 6, d: 2.1, delay: 0.9 },
  { x: 140, r: 4, d: 1.4, delay: 0.2 },
  { x: 90, r: 3, d: 1.1, delay: 1.2 },
  { x: 130, r: 5, d: 1.8, delay: 0.7 }
]

/** Scream canister: glass tube that fills with glowing scream energy */
export function ScreamTank({ level, held, active, score, clipped, compact }: MeterProps): JSX.Element {
  // Unique ids: several tanks can be on screen (team tanks + stage meter)
  const uid = useId().replace(/:/g, '')
  const id = (name: string): string => `${uid}-${name}`
  const fillOffset = (1 - level) * HEIGHT
  const heldY = BOTTOM - held * HEIGHT
  return (
    <svg
      className={`scream-tank ${compact ? 'compact' : ''} ${active ? 'active' : ''}`}
      viewBox="0 0 220 420"
      role="img"
      aria-label={`Nivel de grito ${Math.round(level * 100)}%`}
    >
      <defs>
        <linearGradient id={id('metal')} x1="0" x2="1">
          <stop offset="0" stopColor="#5d7184" />
          <stop offset="0.35" stopColor="#d7e2ea" />
          <stop offset="0.6" stopColor="#8fa3b4" />
          <stop offset="1" stopColor="#4a5b6b" />
        </linearGradient>
        <linearGradient id={id('energy')} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--c-meterLow)" />
          <stop offset="0.5" stopColor="var(--c-meterMid)" />
          <stop offset="1" stopColor="var(--c-meterHigh)" />
        </linearGradient>
        <filter id={id('glow')} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id={id('glass')}>
          <rect x="52" y={TOP} width="116" height={HEIGHT} rx="16" />
        </clipPath>
      </defs>

      {/* inlet pipe + top cap */}
      <rect x="96" y="2" width="28" height="22" rx="4" fill={`url(#${id('metal')})`} />
      <rect x="36" y="20" width="148" height="44" rx="12" fill={`url(#${id('metal')})`} stroke="#2c3a47" strokeWidth="2" />
      {[56, 86, 134, 164].map((x) => (
        <circle key={x} cx={x} cy="42" r="5" fill="#2c3a47" opacity="0.7" />
      ))}
      <circle className={`tank-alarm ${clipped ? 'on' : ''}`} cx="110" cy="42" r="9" />

      {/* glass back */}
      <rect x="52" y={TOP} width="116" height={HEIGHT} rx="16" fill="rgba(160,220,255,0.10)" />

      {/* energy */}
      <g clipPath={`url(#${id('glass')})`}>
        <g className="tank-fill" style={{ transform: `translateY(${fillOffset}px)` }}>
          <rect x="40" y={TOP} width="140" height={HEIGHT + 20} fill={`url(#${id('energy')})`} filter={`url(#${id('glow')})`} />
          <ellipse cx="110" cy={TOP + 2} rx="62" ry="7" fill="rgba(255,255,255,0.45)" />
        </g>
        {active &&
          level > 0.05 &&
          BUBBLES.map((b, i) => (
            <circle
              key={i}
              className="tank-bubble"
              cx={b.x}
              cy={BOTTOM - 6}
              r={b.r}
              style={{ animationDuration: `${b.d}s`, animationDelay: `${b.delay}s` }}
            />
          ))}
      </g>

      {/* glass front: highlight + outline */}
      <rect x="64" y={TOP + 12} width="12" height={HEIGHT - 24} rx="6" fill="white" opacity="0.2" />
      <rect x="52" y={TOP} width="116" height={HEIGHT} rx="16" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="3" />

      {/* scale */}
      {Array.from({ length: 11 }, (_, i) => {
        const y = BOTTOM - (i / 10) * HEIGHT
        return (
          <g key={i}>
            <line x1="172" x2={i % 5 === 0 ? 192 : 184} y1={y} y2={y} stroke="var(--c-textMuted)" strokeWidth="2" />
            {i % 5 === 0 && !compact && (
              <text x="196" y={y + 5} fontSize="14" fill="var(--c-textMuted)">
                {i * 10}
              </text>
            )}
          </g>
        )
      })}

      {/* best-of-turn marker */}
      {held > 0.01 && (
        <g className="tank-held">
          <line x1="48" x2="172" y1={heldY} y2={heldY} stroke="var(--c-danger)" strokeWidth="3" strokeDasharray="8 5" />
          <path d={`M 34 ${heldY - 8} L 48 ${heldY} L 34 ${heldY + 8} Z`} fill="var(--c-danger)" />
        </g>
      )}

      {/* bottom cap + label plate */}
      <rect x="36" y={BOTTOM - 4} width="148" height="50" rx="12" fill={`url(#${id('metal')})`} stroke="#2c3a47" strokeWidth="2" />
      <rect x="66" y={BOTTOM + 8} width="88" height="26" rx="5" fill="#1d2b38" />
      <text x="110" y={BOTTOM + 27} textAnchor="middle" fontSize="15" fill="var(--c-primary)" fontFamily="var(--font-display)">
        GRITOS
      </text>
      <rect x="60" y={BOTTOM + 46} width="100" height="16" rx="4" fill="#3a4a59" />

      {score != null && (
        <text className="tank-score" x="110" y="215" textAnchor="middle" fontSize="54" fontFamily="var(--font-display)">
          {Math.round(score)}
        </text>
      )}
    </svg>
  )
}
