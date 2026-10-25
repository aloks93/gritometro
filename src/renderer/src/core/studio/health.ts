// System health: turns live levels and device/mixer state into status lights and alarms,
// the way a console's front panel would. Pure: the UI feeds it snapshots.

export type HealthStatus = 'ok' | 'off' | 'silence' | 'warning' | 'over' | 'clip'

/** Higher = worse; drives the overall light */
export const STATUS_RANK: Record<HealthStatus, number> = { ok: 0, off: 1, silence: 2, warning: 3, over: 4, clip: 5 }

export const STATUS_LABEL: Record<HealthStatus, string> = { ok: 'OK', off: 'Apagado', silence: 'Silencio', warning: 'Aviso', over: 'Exceso', clip: 'CLIP' }

export type HealthGroup = 'entrada' | 'mezclador' | 'sistema' | 'medida'

export interface HealthItem {
  id: string
  group: HealthGroup
  label: string
  status: HealthStatus
  detail: string
}

export function worstStatus(items: HealthItem[]): HealthStatus {
  return items.reduce<HealthStatus>((w, i) => (STATUS_RANK[i.status] > STATUS_RANK[w] ? i.status : w), 'ok')
}

/** Rolling level history of one signal: peak max, clips and time since it last had signal */
export class LevelTracker {
  private samples: { t: number; peak: number; clipped: boolean }[] = []
  private lastSound = -Infinity
  /** First reading: silence is counted from here, not from "forever" */
  private since = -Infinity

  constructor(
    private windowMs = 3000,
    private soundAboveDb = -60
  ) {}

  push(t: number, peakDb: number, clipped = peakDb > -0.1): void {
    if (!Number.isFinite(this.since)) this.since = t
    this.samples.push({ t, peak: peakDb, clipped })
    if (peakDb > this.soundAboveDb) this.lastSound = t
    const from = t - this.windowMs
    let drop = 0
    while (drop < this.samples.length && this.samples[drop].t < from) drop++
    if (drop) this.samples.splice(0, drop)
  }

  window(now: number): LevelWindow {
    let peak = -100
    let clips = 0
    for (const s of this.samples) {
      if (s.peak > peak) peak = s.peak
      if (s.clipped) clips++
    }
    const ref = Math.max(this.lastSound, this.since)
    return { peakMaxDb: peak, clips, silentForS: Number.isFinite(ref) ? (now - ref) / 1000 : Infinity }
  }

  reset(): void {
    this.samples = []
    this.lastSound = -Infinity
    this.since = -Infinity
  }
}

export interface LevelWindow {
  peakMaxDb: number
  clips: number
  /** Seconds since the signal was last above the silence threshold (Infinity = never) */
  silentForS: number
}

/** A level light: clip beats hot beats silence; silence only after a few quiet seconds */
export function levelHealth(w: LevelWindow, silenceAfterS = 10): { status: HealthStatus; detail: string } {
  if (w.clips > 0 || w.peakMaxDb > -0.5) {
    const n = w.clips || 1
    return { status: 'clip', detail: `Saturó ${n} ${n === 1 ? 'vez' : 'veces'} en los últimos 3 s (pico ${fmt(w.peakMaxDb)} dBFS).` }
  }
  if (w.peakMaxDb > -6) return { status: 'warning', detail: `Pico ${fmt(w.peakMaxDb)} dBFS: poco margen.` }
  if (w.silentForS >= silenceAfterS) return { status: 'silence', detail: Number.isFinite(w.silentForS) ? `Sin señal desde hace ${Math.floor(w.silentForS)} s.` : 'Sin señal.' }
  return { status: 'ok', detail: `Pico ${fmt(w.peakMaxDb)} dBFS.` }
}

export interface HealthInput {
  now: number
  engine: { status: string; label?: string; sampleRate?: number; error?: string }
  input: LevelWindow
  noiseFloorDb: number
  /** Live RMS level, dBFS (for SPL) */
  rmsDb: number
  splOffset: number
  /** SPL above this is flagged "over" (hearing protection) */
  overSplDb: number
  latencyMs: number | null
  calibrationWarnings: string[]
  mixer: {
    status: string
    error?: string
    stripErrors: Record<string, string>
    strips: { id: string; name: string; muted: boolean; level: LevelWindow }[]
    buses: { id: string; label: string; name: string; limitingDb: number; level: LevelWindow }[]
  } | null
  routingWarnings: string[]
  generatorRunning: boolean
  monitorOn: boolean
  deviceEvents: { t: number; text: string; kind: 'added' | 'removed' }[]
}

export function evaluateHealth(h: HealthInput): HealthItem[] {
  const items: HealthItem[] = []
  const add = (id: string, group: HealthGroup, label: string, status: HealthStatus, detail: string): void => {
    items.push({ id, group, label, status, detail })
  }

  // ---- Input
  const e = h.engine
  if (e.status === 'running') add('engine', 'entrada', 'Entrada de audio', 'ok', `${e.label ?? 'Entrada'} · ${e.sampleRate ? e.sampleRate / 1000 : '?'} kHz`)
  else if (e.status === 'disconnected') add('engine', 'entrada', 'Entrada de audio', 'clip', 'El micrófono se desconectó.')
  else if (e.status === 'error') add('engine', 'entrada', 'Entrada de audio', 'clip', e.error ?? 'Error al abrir la entrada.')
  else add('engine', 'entrada', 'Entrada de audio', 'off', e.status === 'starting' ? 'Abriendo…' : 'Sin entrada abierta.')

  if (e.status === 'running') {
    const lv = levelHealth(h.input)
    add('level', 'entrada', 'Nivel de entrada', lv.status, lv.detail)
    if (h.noiseFloorDb > -45) add('noise', 'entrada', 'Ruido de fondo', 'warning', `${fmt(h.noiseFloorDb)} dBFS: sala ruidosa o ganancia muy alta.`)
    else add('noise', 'entrada', 'Ruido de fondo', 'ok', `${fmt(h.noiseFloorDb)} dBFS.`)
    if (e.sampleRate && e.sampleRate !== 44100 && e.sampleRate !== 48000 && e.sampleRate !== 96000)
      add('rate', 'sistema', 'Frecuencia de muestreo', 'warning', `${e.sampleRate} Hz no es una frecuencia de estudio habitual.`)
  }

  // ---- Measurement
  // Below −90 dBFS there's nothing to convert to SPL (digital silence)
  if (e.status === 'running' && h.rmsDb > -90) {
    const spl = h.rmsDb + h.splOffset
    if (spl > h.overSplDb) add('spl', 'medida', 'Nivel sonoro', 'over', `≈${Math.round(spl)} dB SPL: por encima de ${h.overSplDb} dB, protege tus oídos.`)
    else add('spl', 'medida', 'Nivel sonoro', 'ok', `≈${Math.round(spl)} dB SPL.`)
  }
  if (h.calibrationWarnings.length) add('calib', 'medida', 'Calibración', 'warning', h.calibrationWarnings[0])
  else add('calib', 'medida', 'Calibración', 'ok', 'Vigente.')

  // ---- System
  if (h.latencyMs !== null) {
    if (h.latencyMs > 60) add('latency', 'sistema', 'Latencia', 'warning', `${Math.round(h.latencyMs)} ms: alta para escuchar en directo. Usa una interfaz ASIO/WASAPI o baja el búfer.`)
    else add('latency', 'sistema', 'Latencia', 'ok', `${Math.round(h.latencyMs)} ms.`)
  }
  if (h.generatorRunning) add('generator', 'sistema', 'Generador', 'warning', 'Sonando una señal de prueba.')
  if (h.monitorOn) add('monitor', 'sistema', 'Escucha', 'warning', 'Monitorización activa: usa auriculares, con altavoces se acopla.')
  const recent = h.deviceEvents.filter((d) => h.now - d.t < 60000)
  for (const d of recent) add(`dev-${d.t}-${d.kind}-${d.text}`,'sistema', d.kind === 'removed' ? 'Dispositivo desconectado' : 'Dispositivo conectado', d.kind === 'removed' ? 'clip' : 'ok', d.text)

  // ---- Mixer
  const m = h.mixer
  if (m) {
    if (m.status === 'error') add('mixer', 'mezclador', 'Mezclador', 'clip', m.error ?? 'Error')
    else if (m.status === 'on') add('mixer', 'mezclador', 'Mezclador', 'ok', `${m.strips.length} entradas · ${m.buses.length} buses`)
    for (const s of m.strips) {
      const err = m.stripErrors[s.id]
      if (err) {
        add(`strip-${s.id}`, 'mezclador', s.name, 'clip', err)
        continue
      }
      if (m.status !== 'on') continue
      if (s.muted) {
        add(`strip-${s.id}`, 'mezclador', s.name, 'off', 'En mute.')
        continue
      }
      const lv = levelHealth(s.level)
      add(`strip-${s.id}`, 'mezclador', s.name, lv.status, lv.detail)
    }
    if (m.status === 'on')
      for (const b of m.buses) {
        const lv = levelHealth(b.level, Infinity)
        if (lv.status === 'clip') add(`bus-${b.id}`, 'mezclador', `Bus ${b.label}`, 'clip', lv.detail)
        else if (b.limitingDb < -3) add(`bus-${b.id}`, 'mezclador', `Bus ${b.label}`, 'warning', `El limitador recorta ${fmt(-b.limitingDb)} dB: baja las entradas.`)
      }
    for (const [i, w] of h.routingWarnings.entries()) add(`route-${i}`, 'mezclador', 'Ruteo', 'warning', w)
  }
  return items
}

/** What deserves a banner over the whole studio: clipping, excess level, a lost device */
export function alarmsOf(items: HealthItem[]): HealthItem[] {
  return items.filter((i) => i.status === 'clip' || i.status === 'over')
}

/** Input devices that appeared/disappeared between two listings (by label) */
export function deviceChanges(before: string[], after: string[], t: number): { t: number; text: string; kind: 'added' | 'removed' }[] {
  const out: { t: number; text: string; kind: 'added' | 'removed' }[] = []
  for (const l of after) if (!before.includes(l)) out.push({ t, text: l, kind: 'added' })
  for (const l of before) if (!after.includes(l)) out.push({ t, text: l, kind: 'removed' })
  return out
}

function fmt(v: number): string {
  return v <= -99 ? '-∞' : v.toFixed(1)
}
