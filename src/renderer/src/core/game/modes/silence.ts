import { fmtSeconds } from '../GameMode'
import { createAttemptsMode } from './attempts'

export const silenceMode = createAttemptsMode({
  id: 'silence',
  name: 'Reto del silencio',
  description: '¿Quién aguanta más tiempo sin hacer ruido? El medidor vigila...',
  emoji: '🤫',
  turnKind: 'silence',
  format: fmtSeconds
})
