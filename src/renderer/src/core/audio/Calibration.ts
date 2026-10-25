import { MIN_DB, type LevelReading } from './LevelAnalyzer'

/**
 * Ambient noise floor = 90th percentile of the RMS readings by default, so steady party
 * noise raises it (scores stay fair). The studio uses the median for a true noise floor.
 */
export function noiseFloorFrom(readings: LevelReading[], percentile = 0.9): number {
  const values = readings.map((r) => r.rmsDb).filter((v) => v > MIN_DB)
  if (values.length === 0) return -70
  values.sort((a, b) => a - b)
  const idx = Math.min(values.length - 1, Math.floor(values.length * percentile))
  return Math.round(values[idx] * 10) / 10
}
