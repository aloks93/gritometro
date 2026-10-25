// "Blow out the candles": blowing into the mic is loud broadband noise, so the live
// level (0..1 above the noise floor) is enough. Pure state so it can be unit tested.

export interface CandlesState {
  total: number
  lit: number
  /** Blowing accumulated towards the next candle, 0..1 */
  progress: number
}

export interface BlowOptions {
  /** Level (0..1) that counts as blowing */
  threshold: number
  /** Steady blowing at the threshold needed per candle */
  msPerCandle: number
}

export const DEFAULT_BLOW: BlowOptions = { threshold: 0.3, msPerCandle: 600 }

export const MAX_CANDLES = 15

/** One candle per year (5 if the age is unknown) */
export function lightCandles(age?: number): CandlesState {
  const total = Math.min(MAX_CANDLES, Math.max(1, Math.round(age ?? 5)))
  return { total, lit: total, progress: 0 }
}

export function blowCandles(s: CandlesState, level: number, dtMs: number, opts: BlowOptions = DEFAULT_BLOW): CandlesState {
  if (s.lit === 0) return s
  const dt = Math.max(0, Math.min(200, dtMs)) // ignore pauses (tab hidden, slow frame)
  let progress: number
  if (level >= opts.threshold) {
    // Blowing harder puts candles out faster, up to 3x
    const boost = Math.min(3, level / opts.threshold)
    progress = s.progress + (dt / opts.msPerCandle) * boost
  } else {
    // Flames recover when the blowing stops
    progress = Math.max(0, s.progress - dt / (opts.msPerCandle * 2))
  }
  let lit = s.lit
  while (progress >= 1 && lit > 0) {
    lit--
    progress -= 1
  }
  return { ...s, lit, progress: lit === 0 ? 0 : progress }
}

export function allOut(s: CandlesState): boolean {
  return s.lit === 0
}
