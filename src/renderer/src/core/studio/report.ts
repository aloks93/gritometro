import { BAND_CENTERS, technicalScore } from './analysis'
import type { MicCandidate } from './studio'

// Printable comparison report (HTML → PDF in the main process). Pure string building.

export const REPORT_COLORS = ['#e69500', '#1f8fd6', '#2fa860', '#e0456a', '#8a5cf0', '#c9a400', '#1fa89b', '#e5702e']

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function fmt(v: number | undefined | null, digits = 1, unit = ''): string {
  return v === undefined || v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits).replace('.', ',')}${unit}`
}

function chartSvg(candidates: MicCandidate[]): string {
  const W = 760
  const H = 240
  const PAD = { l: 36, r: 10, t: 10, b: 24 }
  const MIN = -30
  const MAX = 15
  const x = (i: number): number => PAD.l + (i / (BAND_CENTERS.length - 1)) * (W - PAD.l - PAD.r)
  const y = (db: number): number => PAD.t + ((MAX - Math.max(MIN, Math.min(MAX, db))) / (MAX - MIN)) * (H - PAD.t - PAD.b)
  const parts: string[] = []
  for (const d of [-30, -20, -10, 0, 10]) {
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(d)}" y2="${y(d)}" stroke="${d === 0 ? '#999' : '#ddd'}"/>`)
    parts.push(`<text x="${PAD.l - 5}" y="${y(d) + 4}" text-anchor="end">${d}</text>`)
  }
  for (const f of [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
    const i = BAND_CENTERS.indexOf(f)
    if (i < 0) continue
    parts.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${PAD.t}" y2="${H - PAD.b}" stroke="#eee"/>`)
    parts.push(`<text x="${x(i)}" y="${H - 7}" text-anchor="middle">${f >= 1000 ? `${f / 1000}k` : f}</text>`)
  }
  candidates.forEach((c, ci) => {
    if (!c.metrics) return
    const pts = c.metrics.curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    parts.push(`<polyline fill="none" stroke="${REPORT_COLORS[ci % REPORT_COLORS.length]}" stroke-width="2.2" points="${pts}"/>`)
  })
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" font-size="10" font-family="Segoe UI, sans-serif" fill="#555">${parts.join('')}</svg>`
}

export interface ReportOptions {
  title?: string
  /** Who/where, e.g. "Sala de ensayo" */
  subtitle?: string
  date?: Date
}

export function buildReportHtml(all: MicCandidate[], opts: ReportOptions = {}): string {
  const date = (opts.date ?? new Date()).toLocaleString('es', { dateStyle: 'long', timeStyle: 'short' })
  const measured = all.filter((c) => c.metrics)
  const ranked = [...measured].sort((a, b) => technicalScore(b.metrics!).total - technicalScore(a.metrics!).total)
  const favorite = [...measured].filter((c) => c.rating).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0]
  const color = (c: MicCandidate): string => REPORT_COLORS[all.indexOf(c) % REPORT_COLORS.length]

  const rows = ranked
    .map((c, i) => {
      const m = c.metrics!
      const s = technicalScore(m)
      return `<tr>
        <td>${i + 1}</td>
        <td><span class="sw" style="background:${color(c)}"></span>${escapeHtml(c.name)}</td>
        <td><b>${s.total}</b></td>
        <td>${fmt(m.snrDb, 1, ' dB')}</td>
        <td>${fmt(m.noiseFloorDb)}${m.noiseADb !== undefined ? `<br><small>A ${fmt(m.noiseADb)}</small>` : ''}</td>
        <td>${fmt(m.levelDb)}</td>
        <td>${fmt(m.lufs)}</td>
        <td>${fmt(m.truePeakDb ?? m.peakDb)}</td>
        <td>${fmt(m.crestDb)}</td>
        <td>${fmt(m.centroidHz / 1000, 2, ' kHz')}</td>
        <td>${Math.round(m.bands.low * 100)} / ${Math.round(m.bands.mid * 100)} / ${Math.round(m.bands.high * 100)}</td>
        <td>${m.clipCount}${m.clippedSamples ? `<br><small>${m.clippedSamples} muestras</small>` : ''}</td>
        <td>${c.rating ? '★'.repeat(c.rating) : '—'}</td>
      </tr>`
    })
    .join('')

  const details = ranked
    .map((c) => {
      const m = c.metrics!
      const s = technicalScore(m)
      return `<div class="card">
        <h3><span class="sw" style="background:${color(c)}"></span>${escapeHtml(c.name)} <small>${s.total}/100</small></h3>
        <p class="bd">SNR ${s.snr}/55 · nivel ${s.level}/15 · saturación ${s.clipping}/15 · balance ${s.balance}/15</p>
        ${c.notes ? `<p>${escapeHtml(c.notes)}</p>` : ''}
        <ul>${s.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('') || '<li>Sin observaciones.</li>'}</ul>
        <p class="bd">${m.hum ? `Zumbido ${m.hum.hz} Hz (+${fmt(m.hum.prominenceDb)} dB) · ` : ''}${m.pitchHz ? `Tono medio ${m.pitchHz} Hz · ` : ''}${m.lra !== undefined ? `LRA ${fmt(m.lra)} LU · ` : ''}Duración ${fmt(m.durationS)} s${c.takenAt ? ` · ${new Date(c.takenAt).toLocaleString('es')}` : ''}</p>
      </div>`
    })
    .join('')

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? 'Comparación de micrófonos')}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1d232b; font-size: 11px; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1d232b; padding-bottom: 6px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0; } h2 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .06em; color: #555; }
  h3 { font-size: 12px; margin: 0 0 4px; } h3 small { color: #777; font-weight: normal; }
  .meta { color: #666; text-align: right; }
  .summary { display: flex; gap: 24px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; font-size: 10px; text-transform: uppercase; } small { color: #777; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 8px; break-inside: avoid; } .card ul { margin: 4px 0; padding-left: 16px; }
  .bd { color: #666; margin: 2px 0; } footer { margin-top: 14px; color: #888; font-size: 9px; }
</style></head><body>
<header><div><h1>${escapeHtml(opts.title ?? 'Comparación de micrófonos')}</h1>${opts.subtitle ? `<div>${escapeHtml(opts.subtitle)}</div>` : ''}</div>
<div class="meta">Gritómetro Studio<br>${escapeHtml(date)}</div></header>
<div class="summary">
  ${ranked[0] ? `<span>Mejor técnicamente: <b>${escapeHtml(ranked[0].name)}</b></span>` : ''}
  ${favorite ? `<span>Favorito en la prueba a ciegas: <b>${escapeHtml(favorite.name)}</b></span>` : ''}
  <span>Micrófonos medidos: <b>${measured.length}</b></span>
</div>
<h2>Resultados</h2>
<table><thead><tr><th>#</th><th>Micrófono</th><th>Puntos</th><th>SNR</th><th>Ruido dBFS</th><th>Nivel dBFS</th><th>LUFS</th><th>Pico dBTP</th><th>Cresta dB</th><th>Brillo</th><th>Graves/Medios/Agudos %</th><th>Clips</th><th>A ciegas</th></tr></thead>
<tbody>${rows || '<tr><td colspan="13">Sin tomas medidas.</td></tr>'}</tbody></table>
<h2>Respuesta en frecuencia (tercios de octava, normalizada)</h2>
${chartSvg(all)}
<h2>Detalle</h2>
<div class="cards">${details}</div>
<footer>La puntuación técnica es orientativa (SNR 55, nivel 15, saturación 15, balance tonal 15). La prueba a ciegas con volumen igualado es la referencia subjetiva.</footer>
</body></html>`
}
