import { memo } from 'react'
import type { Player } from '../../core/players/players'

const EYE_X: Record<number, number[]> = { 1: [50], 2: [38, 62], 3: [32, 50, 68] }

/** Procedurally drawn little monster for each player (or their uploaded photo) */
export const MonsterAvatar = memo(function MonsterAvatar({ player, size = 64 }: { player: Pick<Player, 'avatar' | 'photo' | 'name'>; size?: number }): JSX.Element {
  if (player.photo) {
    return <img className="avatar-photo" src={player.photo} width={size} height={size} alt={player.name} />
  }
  const { hue, eyes, horns, fur, spots, mouth } = player.avatar
  const body = `hsl(${hue} 75% 58%)`
  const dark = `hsl(${hue} 60% 35%)`
  const eyeR = eyes === 1 ? 15 : eyes === 2 ? 10 : 8
  return (
    <svg className="monster-avatar" width={size} height={size} viewBox="0 0 100 100" aria-label={player.name}>
      {horns && (
        <g fill="#f5f0e1" stroke={dark} strokeWidth="2">
          <path d="M 26 30 Q 14 10 22 4 Q 30 18 36 26 Z" />
          <path d="M 74 30 Q 86 10 78 4 Q 70 18 64 26 Z" />
        </g>
      )}
      {fur ? (
        <path
          d="M50 12 L57 20 L66 15 L69 25 L80 24 L79 35 L89 40 L83 49 L90 58 L80 63 L82 74 L71 75 L67 86 L57 81 L50 90 L43 81 L33 86 L29 75 L18 74 L20 63 L10 58 L17 49 L11 40 L21 35 L20 24 L31 25 L34 15 L43 20 Z"
          fill={body}
          stroke={dark}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      ) : (
        <ellipse cx="50" cy="52" rx="38" ry="36" fill={body} stroke={dark} strokeWidth="2.5" />
      )}
      {spots && (
        <g fill={dark} opacity="0.35">
          <circle cx="28" cy="66" r="5" />
          <circle cx="74" cy="70" r="4" />
          <circle cx="68" cy="30" r="3.5" />
        </g>
      )}
      {EYE_X[eyes].map((x) => (
        <g key={x}>
          <circle cx={x} cy="44" r={eyeR} fill="white" stroke={dark} strokeWidth="2" />
          <circle cx={x + eyeR * 0.2} cy="45" r={eyeR * 0.45} fill="#1b1b2f" />
          <circle cx={x + eyeR * 0.35} cy="42" r={eyeR * 0.15} fill="white" />
        </g>
      ))}
      {mouth === 'grin' && <path d="M 32 66 Q 50 82 68 66" fill="none" stroke="#1b1b2f" strokeWidth="4" strokeLinecap="round" />}
      {mouth === 'open' && <ellipse cx="50" cy="70" rx="12" ry="9" fill="#5a1530" stroke="#1b1b2f" strokeWidth="2" />}
      {mouth === 'fangs' && (
        <g>
          <path d="M 30 64 Q 50 80 70 64 Z" fill="#5a1530" stroke="#1b1b2f" strokeWidth="2.5" />
          <path d="M 38 67 L 41 74 L 44 69 Z M 56 69 L 59 74 L 62 67 Z" fill="white" />
        </g>
      )}
    </svg>
  )
})
