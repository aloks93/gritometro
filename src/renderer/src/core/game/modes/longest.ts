import { fmtSeconds } from '../GameMode'
import { createAttemptsMode } from './attempts'

export const longestMode = createAttemptsMode({
  id: 'longest',
  name: 'El grito más largo',
  description: '¡Aguanta el grito sin parar! Gana quien lo sostenga más tiempo. Respirar = se acabó.',
  emoji: '⏱️',
  turnKind: 'sustain',
  format: fmtSeconds
})
