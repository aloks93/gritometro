import { technicalScore } from './analysis'
import type { CalibrationRecord } from './calibration'
import { escapeHtml } from './report'
import { winnersByScenario } from './scenario'
import type { MicCandidate } from './studio'

// Measurement sessions: markers/timecode on takes, and a session file + report that ties
// together who measured what, with which mic/calibration/gain, and what came out of it.

export interface Marker {
  /** Seconds from the start of the take */
  t: number
  label: string
  kind: 'user' | 'clip'
}

/** SMPTE-style HH:MM:SS:FF */
export function timecode(seconds: number, fps = 25): string {
  const total = Math.max(0, Math.floor(seconds * fps + 1e-6))
  const ff = total % fps
  const s = Math.floor(total / fps)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`
}

/**
 * One marker per clipping event: runs of samples at full scale closer than `mergeS`
 * count as one event, labelled with how many samples clipped.
 */
export function clipMarkers(pcm: Float32Array, sampleRate: number, mergeS = 0.25, threshold = 0.999): Marker[] {
  const out: Marker[] = []
  const gap = Math.round(mergeS * sampleRate)
  let start = -1
  let last = -Infinity
  let count = 0
  const flush = (): void => {
    if (start >= 0) out.push({ t: Math.round((start / sampleRate) * 1000) / 1000, label: `Saturación (${count} muestra${count === 1 ? '' : 's'})`, kind: 'clip' })
  }
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) < threshold) continue
    if (i - last > gap) {
      flush()
      start = i
      count = 0
    }
    count++
    last = i
  }
  flush()
  return out
}

/** User markers plus fresh clip markers (old clip markers are replaced), in time order */
export function withClipMarkers(markers: Marker[], clips: Marker[]): Marker[] {
  return [...markers.filter((m) => m.kind !== 'clip'), ...clips].sort((a, b) => a.t - b.t)
}

/** Semicolon CSV (Spanish Excel) with a BOM: one row per marker */
export function markersCsv(takes: { name: string; markers: Marker[] }[], fps = 25): string {
  const rows = [['Toma', 'Timecode', 'Segundos', 'Tipo', 'Etiqueta']]
  for (const t of takes)
    for (const m of t.markers) rows.push([t.name, timecode(m.t, fps), m.t.toFixed(3).replace('.', ','), m.kind === 'clip' ? 'Saturación' : 'Marcador', m.label])
  return '﻿' + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\r\n')
}

// ---- Session file and report

export interface SessionMeta {
  title: string
  operator: string
  location: string
  notes: string
}

export function defaultSessionMeta(): SessionMeta {
  return { title: '', operator: '', location: '', notes: '' }
}

export interface SessionTake {
  name: string
  durationS: number
  sampleRate: number
  lufs: number
  truePeakDb: number
  peakDb: number
  rmsDb: number
  clippedSamples: number
  markers: Marker[]
}

export interface MeasurementSession {
  app: typeof SESSION_APP
  version: 1
  createdAt: string
  meta: SessionMeta
  profile: { name: string; deviceLabel?: string; mode: 'simple' | 'advanced'; gainDb: number; splOffset: number; noiseFloorDb: number }
  calibration?: CalibrationRecord
  takes: SessionTake[]
  candidates: MicCandidate[]
}

const SESSION_APP = 'gritometro-sesion-medicion'

export function buildSession(input: Omit<MeasurementSession, 'app' | 'version' | 'createdAt'>, now = new Date()): MeasurementSession {
  return { app: SESSION_APP, version: 1, createdAt: now.toISOString(), ...input }
}

export function serializeMeasurementSession(s: MeasurementSession): string {
  return JSON.stringify(s, null, 2)
}

export function parseMeasurementSession(text: string): MeasurementSession {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('El archivo no es un JSON válido.')
  }
  const r = raw as Partial<MeasurementSession>
  if (!r || r.app !== SESSION_APP) throw new Error('No es una sesión de medición del Gritómetro Studio.')
  if (!r.profile || !Array.isArray(r.takes) || !Array.isArray(r.candidates)) throw new Error('La sesión está incompleta.')
  return { ...r, meta: { ...defaultSessionMeta(), ...r.meta } } as MeasurementSession
}

/** Plain-language conclusions: best mic, problem takes, calibration and noise */
export function sessionConclusions(s: MeasurementSession): string[] {
  const out: string[] = []
  const measured = s.candidates.filter((c) => c.metrics)
  if (measured.length > 0) {
    const ranked = [...measured].sort((a, b) => technicalScore(b.metrics!).total - technicalScore(a.metrics!).total)
    const best = ranked[0]
    const score = technicalScore(best.metrics!)
    out.push(`Micrófono recomendado: ${best.name} (${score.total}/100${ranked[1] ? `, ${score.total - technicalScore(ranked[1].metrics!).total} puntos sobre ${ranked[1].name}` : ''}).`)
    const fav = measured.filter((c) => c.rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0]
    if (fav && fav.id !== best.id) out.push(`En la prueba a ciegas se prefirió ${fav.name}: decide entre lo técnico y lo que suena mejor al oído.`)
    const noisiest = [...measured].sort((a, b) => b.metrics!.noiseFloorDb - a.metrics!.noiseFloorDb)[0]
    if (measured.length > 1) out.push(`Peor ruido de fondo: ${noisiest.name} (${noisiest.metrics!.noiseFloorDb} dBFS).`)
    // Only worth listing when the winner changes with the use
    const perUse = winnersByScenario(measured)
    if (measured.length > 1 && new Set(perUse.map((w) => w.best.id)).size > 1) out.push(`Por uso: ${perUse.map((w) => `${w.scenario.name} → ${w.best.name}`).join('; ')}.`)
  }
  const clipped = s.takes.filter((t) => t.clippedSamples > 0)
  if (clipped.length) out.push(`Tomas con saturación: ${clipped.map((t) => t.name).join(', ')}. Baja la ganancia y repítelas.`)
  const hot = s.takes.filter((t) => t.clippedSamples === 0 && t.truePeakDb > -1)
  if (hot.length) out.push(`True peak por encima de −1 dBTP en: ${hot.map((t) => t.name).join(', ')}.`)
  if (!s.calibration) out.push('Sin calibración acústica: los dB SPL de esta sesión son aproximados.')
  else out.push(`Calibrado el ${new Date(s.calibration.atIso).toLocaleDateString('es')} (offset ${s.calibration.offsetDb} dB).`)
  if (s.profile.noiseFloorDb > -50) out.push(`Ruido de fondo alto (${s.profile.noiseFloorDb} dBFS): la sala o la ganancia limitan la medida.`)
  if (out.length === 0) out.push('Sin tomas ni micrófonos medidos todavía.')
  return out
}

function f1(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) || v <= -99 ? '—' : v.toFixed(1).replace('.', ',')
}

export function buildSessionReportHtml(s: MeasurementSession): string {
  const title = s.meta.title.trim() || 'Sesión de medición'
  const date = new Date(s.createdAt).toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' })
  const who = [s.meta.operator && `Operador: ${s.meta.operator}`, s.meta.location && `Lugar: ${s.meta.location}`].filter(Boolean).join(' · ')
  const cal = s.calibration
  const takes = s.takes
    .map(
      (t) => `<tr><td>${escapeHtml(t.name)}</td><td>${timecode(t.durationS)}</td><td>${t.sampleRate / 1000} kHz</td><td>${f1(t.lufs)}</td><td>${f1(t.truePeakDb)}</td><td>${f1(t.peakDb)}</td><td>${f1(t.rmsDb)}</td><td class="${t.clippedSamples ? 'bad' : ''}">${t.clippedSamples}</td><td>${t.markers.length}</td></tr>`
    )
    .join('')
  const markers = s.takes
    .flatMap((t) => t.markers.map((m) => `<tr><td>${escapeHtml(t.name)}</td><td>${timecode(m.t)}</td><td>${m.kind === 'clip' ? 'Saturación' : 'Marcador'}</td><td>${escapeHtml(m.label)}</td></tr>`))
    .join('')
  const mics = s.candidates
    .filter((c) => c.metrics)
    .map((c) => ({ c, sc: technicalScore(c.metrics!) }))
    .sort((a, b) => b.sc.total - a.sc.total)
    .map(({ c, sc }, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(c.name)}</td><td><b>${sc.total}</b></td><td>${f1(c.metrics!.snrDb)}</td><td>${f1(c.metrics!.noiseFloorDb)}</td><td>${f1(c.metrics!.lufs)}</td><td>${c.rating ? '★'.repeat(c.rating) : '—'}</td><td>${escapeHtml(sc.notes.join('; ') || '—')}</td></tr>`)
    .join('')
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1d232b; font-size: 11px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1d232b; padding-bottom: 6px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .06em; color: #555; break-after: avoid; }
  .meta { color: #666; text-align: right; } table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; } th { background: #f2f4f7; font-size: 10px; text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; } .box { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
  .box b { display: block; font-size: 10px; text-transform: uppercase; color: #777; } .concl li { margin: 3px 0; font-size: 12px; } .bad { color: #c0263a; font-weight: bold; }
  .notes { white-space: pre-wrap; } footer { margin-top: 14px; color: #888; font-size: 9px; }
</style></head><body>
<header><div><h1>${escapeHtml(title)}</h1>${who ? `<div>${escapeHtml(who)}</div>` : ''}</div><div class="meta">Gritómetro Studio<br>${escapeHtml(date)}</div></header>
<h2>Conclusiones</h2>
<ul class="concl">${sessionConclusions(s)
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join('')}</ul>
<h2>Configuración</h2>
<div class="grid">
  <div class="box"><b>Perfil de audio</b>${escapeHtml(s.profile.name)}<br>${escapeHtml(s.profile.deviceLabel ?? 'Entrada predeterminada')}<br>Modo ${s.profile.mode === 'advanced' ? 'avanzado' : 'simple'} · ganancia ${f1(s.profile.gainDb)} dB</div>
  <div class="box"><b>Calibración</b>${cal ? `${escapeHtml(new Date(cal.atIso).toLocaleString('es'))}<br>${cal.method === 'calibrator' ? `Calibrador ${cal.refDb} dB` : cal.method === 'manual' ? `Sonómetro de referencia ${cal.refDb} dB(A)` : 'Loopback'}<br>Offset ${f1(cal.offsetDb)} dB${cal.spreadDb !== undefined ? ` · estabilidad ±${(cal.spreadDb / 2).toFixed(2)} dB` : ''}` : 'Sin calibrar'}</div>
  <div class="box"><b>Ruido de fondo</b>${f1(s.profile.noiseFloorDb)} dBFS<br>Offset SPL actual ${f1(s.profile.splOffset)} dB<br>≈ ${f1(s.profile.noiseFloorDb + s.profile.splOffset)} dB SPL</div>
</div>
${s.meta.notes.trim() ? `<h2>Notas</h2><p class="notes">${escapeHtml(s.meta.notes)}</p>` : ''}
${mics ? `<h2>Micrófonos comparados</h2><table><thead><tr><th>#</th><th>Micrófono</th><th>Puntos</th><th>SNR dB</th><th>Ruido dBFS</th><th>LUFS</th><th>A ciegas</th><th>Observaciones</th></tr></thead><tbody>${mics}</tbody></table>` : ''}
${takes ? `<h2>Tomas</h2><table><thead><tr><th>Toma</th><th>Duración</th><th>Muestreo</th><th>LUFS</th><th>True peak</th><th>Pico</th><th>RMS</th><th>Muestras saturadas</th><th>Marcadores</th></tr></thead><tbody>${takes}</tbody></table>` : ''}
${markers ? `<h2>Marcadores</h2><table><thead><tr><th>Toma</th><th>Timecode</th><th>Tipo</th><th>Etiqueta</th></tr></thead><tbody>${markers}</tbody></table>` : ''}
<footer>Timecode HH:MM:SS:FF a 25 fps. Niveles en dBFS salvo indicación. La puntuación de micrófonos es orientativa (SNR 55, nivel 15, saturación 15, balance 15).</footer>
</body></html>`
}
