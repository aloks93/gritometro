// Calibration bookkeeping and validation: acoustic calibrator checks, IEC tolerance,
// calibration history per audio profile, loopback (electrical) chain check and gain advice.

export type CalibrationMethod = 'calibrator' | 'manual' | 'loopback'

export interface CalibrationRecord {
  id: string
  atIso: string
  method: CalibrationMethod
  /** SPL offset that was applied (dB SPL = dBFS + offset) */
  offsetDb: number
  /** Reference level of the calibrator, dB SPL (calibrator method) */
  refDb?: number
  /** Level the input read, dBFS */
  measuredDbfs?: number
  /** Max − min of the 100 ms blocks during the measurement */
  spreadDb?: number
  /** Frequency the calibrator tone was detected at */
  freqHz?: number
  /** Input device label at calibration time (to notice a mic swap) */
  deviceLabel?: string
  /** Profile digital gain at calibration time (changing it invalidates the offset) */
  gainDb?: number
  note?: string
}

export type ToleranceClass = 1 | 2

/** IEC 61672-1 acceptance limits at the 1 kHz reference, dB */
export const TOLERANCE_DB: Record<ToleranceClass, number> = { 1: 1.1, 2: 1.4 }

/** Calibrators are 1 kHz; a few % covers cheap units and FFT resolution */
const CALIBRATOR_HZ = 1000
const FREQ_TOLERANCE = 0.03
const MAX_SPREAD_DB = 0.6
const HISTORY_MAX = 12

export interface SignalCheck {
  ok: boolean
  /** Mean level of the blocks, dBFS (power average) */
  levelDbfs: number
  spreadDb: number
  problems: string[]
}

/**
 * Is this a usable calibrator signal? Steady (blocks within MAX_SPREAD_DB), loud enough,
 * not clipping, and at ~1 kHz when a dominant frequency is given.
 */
export function checkCalibratorSignal(blocksDbfs: number[], dominantHz: number | null, peakDbfs = -100): SignalCheck {
  const problems: string[] = []
  const valid = blocksDbfs.filter((v) => Number.isFinite(v))
  if (valid.length < 5) return { ok: false, levelDbfs: -100, spreadDb: 0, problems: ['Medida demasiado corta.'] }
  const levelDbfs = round1(10 * Math.log10(valid.reduce((a, v) => a + Math.pow(10, v / 10), 0) / valid.length))
  const spreadDb = round1(Math.max(...valid) - Math.min(...valid))
  if (levelDbfs < -70) problems.push('Señal demasiado baja: ¿está el calibrador encendido y bien encajado?')
  if (peakDbfs > -0.5) problems.push('La entrada satura: baja la ganancia del preamplificador y repite.')
  if (spreadDb > MAX_SPREAD_DB) problems.push(`El nivel varía ${spreadDb} dB: no muevas el micrófono y aleja fuentes de ruido.`)
  if (dominantHz !== null && Math.abs(dominantHz - CALIBRATOR_HZ) > CALIBRATOR_HZ * FREQ_TOLERANCE)
    problems.push(`El tono está en ${Math.round(dominantHz)} Hz, no en 1 kHz: ¿es un calibrador?`)
  return { ok: problems.length === 0, levelDbfs, spreadDb, problems }
}

export interface Verification {
  /** Measured − reference, dB */
  deviationDb: number
  toleranceDb: number
  pass: boolean
  message: string
}

/** Re-measuring the calibrator: how far the calibrated reading is from its nominal level */
export function verifyAgainstReference(measuredSpl: number, referenceDb: number, cls: ToleranceClass): Verification {
  const deviationDb = round1(measuredSpl - referenceDb)
  const toleranceDb = TOLERANCE_DB[cls]
  const pass = Math.abs(deviationDb) <= toleranceDb
  const sign = deviationDb > 0 ? '+' : ''
  const message = pass
    ? `Dentro de tolerancia clase ${cls} (${sign}${deviationDb} dB, límite ±${toleranceDb} dB).`
    : `Fuera de tolerancia clase ${cls}: ${sign}${deviationDb} dB (límite ±${toleranceDb} dB). Vuelve a calibrar.`
  return { deviationDb, toleranceDb, pass, message }
}

/** Newest first, capped */
export function pushCalibration(history: CalibrationRecord[], rec: CalibrationRecord): CalibrationRecord[] {
  return [rec, ...history.filter((h) => h.id !== rec.id)].slice(0, HISTORY_MAX)
}

/** Reasons the current calibration may no longer hold */
export function calibrationWarnings(rec: CalibrationRecord | undefined, current: { deviceLabel?: string; gainDb: number; offsetDb: number }, now = new Date()): string[] {
  if (!rec) return ['Este perfil no está calibrado: los dB SPL son aproximados.']
  const out: string[] = []
  const days = Math.floor((now.getTime() - new Date(rec.atIso).getTime()) / 86400000)
  if (days > 30) out.push(`La calibración tiene ${days} días: conviene verificarla.`)
  if (rec.deviceLabel && current.deviceLabel && rec.deviceLabel !== current.deviceLabel) out.push(`Se calibró con «${rec.deviceLabel}» y ahora la entrada es «${current.deviceLabel}».`)
  if (rec.gainDb !== undefined && Math.abs(rec.gainDb - current.gainDb) > 0.05) out.push(`La ganancia del perfil cambió (${rec.gainDb} → ${current.gainDb} dB) desde la calibración.`)
  if (Math.abs(rec.offsetDb - current.offsetDb) > 0.05) out.push('El offset se modificó a mano después de calibrar.')
  return out
}

// ---- Loopback: output → cable → input

export interface LoopbackPoint {
  hz: number
  sentDbfs: number
  receivedDbfs: number
}

export interface LoopbackResult {
  /** received − sent at 1 kHz (or the first point): the chain's gain */
  gainDb: number
  /** Response at each frequency relative to the reference point, dB */
  response: { hz: number; db: number }[]
  /** Max − min of the response */
  flatnessDb: number
  message: string
}

export function loopbackResult(points: LoopbackPoint[]): LoopbackResult | null {
  const valid = points.filter((p) => p.receivedDbfs > -90)
  if (valid.length === 0) return null
  const ref = valid.find((p) => p.hz === 1000) ?? valid[0]
  const gainDb = round1(ref.receivedDbfs - ref.sentDbfs)
  const response = valid.map((p) => ({ hz: p.hz, db: round1(p.receivedDbfs - p.sentDbfs - gainDb) }))
  const dbs = response.map((r) => r.db)
  const flatnessDb = round1(Math.max(...dbs) - Math.min(...dbs))
  const parts: string[] = []
  parts.push(Math.abs(gainDb) < 0.5 ? 'La cadena devuelve el mismo nivel que envía.' : `La cadena ${gainDb > 0 ? 'suma' : 'pierde'} ${Math.abs(gainDb)} dB.`)
  parts.push(flatnessDb <= 1 ? `Respuesta plana (±${round1(flatnessDb / 2)} dB).` : `Respuesta irregular: ${flatnessDb} dB entre frecuencias. ¿Hay EQ o mejoras de Windows activas?`)
  return { gainDb, response, flatnessDb, message: parts.join(' ') }
}

// ---- Gain staging from noise floor and loudest peak

export interface GainAdvice {
  /** Suggested change of the preamp gain, dB (0 = leave it) */
  changeDb: number
  /** Peak − noise floor: the usable dynamic range at the current gain */
  rangeDb: number
  headroomDb: number
  status: 'ok' | 'raise' | 'lower' | 'noisy'
  message: string
}

/**
 * Target: the loudest peak lands at −12 dBFS (room for a stronger shout). Raising the
 * preamp lifts the noise too, so the advice also says when the room itself is the limit.
 */
export function gainAdvice(noiseFloorDbfs: number, loudPeakDbfs: number, targetPeakDbfs = -12): GainAdvice {
  const rangeDb = round1(loudPeakDbfs - noiseFloorDbfs)
  const headroomDb = round1(-loudPeakDbfs)
  const raw = targetPeakDbfs - loudPeakDbfs
  const changeDb = Math.abs(raw) < 3 ? 0 : Math.round(raw)
  if (loudPeakDbfs > -1) return { changeDb: Math.min(changeDb, -6), rangeDb, headroomDb, status: 'lower', message: `Satura: baja el preamplificador unos ${Math.abs(Math.min(changeDb, -6))} dB.` }
  if (rangeDb < 30) return { changeDb, rangeDb, headroomDb, status: 'noisy', message: `Solo ${rangeDb} dB entre el ruido y tu voz: acerca el micrófono o reduce el ruido de la sala; subir la ganancia no ayuda.` }
  if (changeDb > 0) return { changeDb, rangeDb, headroomDb, status: 'raise', message: `Sube el preamplificador ${changeDb} dB: los picos quedarán cerca de ${targetPeakDbfs} dBFS.` }
  if (changeDb < 0) return { changeDb, rangeDb, headroomDb, status: 'lower', message: `Baja el preamplificador ${-changeDb} dB para tener margen ante un grito más fuerte.` }
  return { changeDb: 0, rangeDb, headroomDb, status: 'ok', message: `Ganancia correcta: ${headroomDb} dB de margen y ${rangeDb} dB sobre el ruido.` }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
