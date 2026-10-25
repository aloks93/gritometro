import { MIN_DB, type LevelReading } from './LevelAnalyzer'

/**
 * Ambient noise floor = 90th percentile of the RMS readings, so occasional
 * party chatter spikes don't raise it but steady background noise does.
 */
export function noiseFloorFrom(readings: LevelReading[]): number {
  const values = readings.map((r) => r.rmsDb).filter((v) => v > MIN_DB)
  if (values.length === 0) return -70
  values.sort((a, b) => a - b)
  const idx = Math.min(values.length - 1, Math.floor(values.length * 0.9))
  return Math.round(values[idx] * 10) / 10
}
