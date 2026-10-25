import { fmtPoints } from '../GameMode'
import { createAttemptsMode } from './attempts'

export const rankingMode = createAttemptsMode({
  id: 'ranking',
  name: 'Ranking de récords',
  description: 'Todos gritan y se arma la tabla de la fiesta. ¡Vale el mejor intento!',
  emoji: '🏆',
  turnKind: 'scream',
  format: fmtPoints
})
