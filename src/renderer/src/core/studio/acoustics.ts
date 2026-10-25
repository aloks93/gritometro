// Room acoustics: reverberation time from a recorded decay (interrupted noise or a clap),
// with Schroeder backward integration and a least-squares fit, ISO 3382 style.

export interface Rt60Result {
  /** Fitted −5…−25 dB, extrapolated to 60 dB (s) */
  t20: number | null
  /** Fitted −5…−35 dB, extrapolated to 60 dB (s) */
  t30: number | null
  /** Early decay time: 0…−10 dB, extrapolated (s) */
  edt: number | null
  /** Usable decay range above the noise floor, dB */
  dynamicRangeDb: number
  /** Schroeder curve in dB, one point per `stepMs`, from the start of the decay */
  curve: number[]
  stepMs: number
}

/** Energy envelope in dB over windows of `winMs` */
export function energyEnvelope(pcm: Float32Array, sampleRate: number, winMs = 10): number[] {
  const n = Math.max(1, Math.round((sampleRate * winMs) / 1000))
  const out: number[] = []
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0
    for (let j = i; j < i + n; j++) s += pcm[j] * pcm[j]
    out.push(s > 0 ? 10 * Math.log10(s / n) : -200)
  }
  return out
}

function fitSlope(ys: number[], x0: number, stepS: number, from: number, to: number): number | null {
  // Points of the curve between `from` and `to` dB (both negative)
  const pts: [number, number][] = []
  ys.forEach((y, i) => {
    if (y <= from && y >= to) pts.push([(x0 + i) * stepS, y])
  })
  if (pts.length < 3) return null
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length
  let num = 0
  let den = 0
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my)
    den += (x - mx) ** 2
  }
  const slope = den > 0 ? num / den : 0
  return slope < 0 ? -60 / slope : null
}

/**
 * Finds the loudest moment, treats everything after it as the decay, estimates the noise
 * floor from the tail and integrates backwards (Schroeder) up to where the decay meets it.
 */
export function measureRt60(pcm: Float32Array, sampleRate: number, stepMs = 10): Rt60Result {
  const env = energyEnvelope(pcm, sampleRate, stepMs)
  const empty: Rt60Result = { t20: null, t30: null, edt: null, dynamicRangeDb: 0, curve: [], stepMs }
  if (env.length < 20) return empty
  let peak = 0
  env.forEach((v, i) => {
    if (v > env[peak]) peak = i
  })
  const tail = env.slice(Math.floor(env.length * 0.85))
  const noise = [...tail].sort((a, b) => a - b)[Math.floor(tail.length / 2)]
  const range = env[peak] - noise
  if (range < 20) return { ...empty, dynamicRangeDb: Math.round(range) }
  // End of the usable decay: first point within 5 dB of the noise floor
  let end = env.length
  for (let i = peak; i < env.length; i++) {
    if (env[i] < noise + 5) {
      end = i
      break
    }
  }
  const lin = env.slice(peak, end).map((d) => Math.pow(10, d / 10))
  const curve: number[] = new Array(lin.length)
  let acc = 0
  for (let i = lin.length - 1; i >= 0; i--) {
    acc += lin[i]
    curve[i] = acc
  }
  const total = curve[0]
  const db = curve.map((v) => 10 * Math.log10(v / total))
  const stepS = stepMs / 1000
  const round2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100)
  return {
    t20: round2(fitSlope(db, 0, stepS, -5, -25)),
    t30: range >= 45 ? round2(fitSlope(db, 0, stepS, -5, -35)) : null,
    edt: round2(fitSlope(db, 0, stepS, 0, -10)),
    dynamicRangeDb: Math.round(range),
    curve: db.map((v) => Math.round(v * 10) / 10),
    stepMs
  }
}

/** Plain-language reading of an RT60 for speech/recording */
export function rt60Verdict(rt: number): string {
  if (rt < 0.3) return 'Muy seca: ideal para locución y grabación de voz.'
  if (rt < 0.6) return 'Controlada: buena para voz y estudio casero.'
  if (rt < 1.0) return 'Algo viva: la voz suena con sala; conviene tratarla para grabar.'
  if (rt < 1.8) return 'Reverberante: la palabra pierde claridad. Añade absorción (cortinas, sofás, paneles).'
  return 'Muy reverberante (tipo iglesia/gimnasio): difícil para voz hablada.'
}
