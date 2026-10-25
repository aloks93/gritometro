import { useEffect, useRef } from 'react'
import { audioEngine } from '../../core/audio/AudioEngine'
import { noteName, thirdOctavePower } from '../../core/studio/analysis'
import type { SpectrumMode } from '../../core/studio/studio'
import { fitCanvas } from './widgets'

const FREQ_LABELS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
/** Full ISO third-octave series for the live RTA */
export const RTA_CENTERS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300,
  8000, 10000, 12500, 16000, 20000
]
const WATERFALL_POINTS = 240
const WATERFALL_LINES = 40
const fx = (f: number, w: number): number => (Math.log10(f / 20) / Math.log10(1000)) * w
const fOfX = (x: number, w: number): number => 20 * Math.pow(1000, x / w)
const fmtHz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}`)

/** Dark → violet → orange → pale yellow, for the spectrogram */
export function heat(t: number): [number, number, number] {
  const v = Math.min(1, Math.max(0, t))
  const stops: [number, [number, number, number]][] = [
    [0, [11, 13, 16]],
    [0.3, [70, 30, 120]],
    [0.6, [220, 70, 60]],
    [0.85, [255, 176, 32]],
    [1, [255, 245, 200]]
  ]
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]
    const [p0, c0] = stops[i - 1]
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return stops[stops.length - 1][1]
}

interface Props {
  mode: SpectrumMode
  floorDb: number
  height?: number
  reference?: Float32Array | null
  paused?: boolean
}

/**
 * Live analyzer: FFT line (with peak hold, reference curve and a hover cursor),
 * third-octave RTA bars, or a scrolling spectrogram.
 */
export function SpectrumView({ mode, floorDb, height = 280, reference = null, paused = false }: Props): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const props = useRef({ mode, floorDb, reference, paused })
  props.current = { mode, floorDb, reference, paused }
  const mouse = useRef<number | null>(null)

  useEffect(() => {
    let raf = 0
    let peaks: Float32Array | null = null
    let rtaPeaks: number[] = []
    let lastMode: SpectrumMode | null = null
    let linear: Float32Array | null = null
    // Spectrogram history as a ring of columns (self-drawImage scrolling proved unreliable)
    let ring: ImageData | null = null
    let ringPos = 0
    let rowBins: Int32Array | null = null
    // Waterfall: recent spectra resampled to log-spaced points, newest last
    const history: Float32Array[] = []
    let frame = 0

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const { mode, floorDb, reference, paused } = props.current
      if (paused) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      const range = -floorDb
      const yOf = (db: number): number => Math.min(h, Math.max(0, (-db / range) * h))
      const s = audioEngine.spectrumDb()
      const dpr = devicePixelRatio
      g.font = `${11 * dpr}px Consolas, monospace`

      if (mode !== lastMode) {
        g.clearRect(0, 0, w, h)
        lastMode = mode
        rowBins = null
        history.length = 0
      }

      if (mode === 'waterfall') {
        if (!s) return
        // A new line every 3 frames (~20/s) keeps 2 s of history on screen
        if (frame++ % 3 === 0) {
          const line = new Float32Array(WATERFALL_POINTS)
          for (let p = 0; p < WATERFALL_POINTS; p++) {
            const f0 = 20 * Math.pow(1000, p / WATERFALL_POINTS)
            const f1 = 20 * Math.pow(1000, (p + 1) / WATERFALL_POINTS)
            const b0 = Math.max(1, Math.floor((f0 * s.fftSize) / s.sampleRate))
            const b1 = Math.min(s.data.length - 1, Math.max(b0, Math.ceil((f1 * s.fftSize) / s.sampleRate)))
            let m = -200
            for (let i = b0; i <= b1; i++) if (s.data[i] > m) m = s.data[i]
            line[p] = m
          }
          history.push(line)
          if (history.length > WATERFALL_LINES) history.shift()
        }
        g.clearRect(0, 0, w, h)
        const depthX = w * 0.18
        const depthY = h * 0.45
        const plotW = w - depthX
        const plotH = h - depthY
        g.fillStyle = css.getPropertyValue('--st-muted')
        for (const f of FREQ_LABELS) g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), fx(f, plotW) + 3, h - 4)
        // Oldest at the back (top right), newest in front: each line hides what's behind it
        history.forEach((line, idx) => {
          const age = (history.length - 1 - idx) / WATERFALL_LINES
          const ox = depthX * age
          const oy = h - depthY * age
          g.beginPath()
          g.moveTo(ox, oy)
          for (let p = 0; p < line.length; p++) {
            const t = Math.max(0, Math.min(1, (line[p] - floorDb) / range))
            g.lineTo(ox + (p / (line.length - 1)) * plotW, oy - t * plotH)
          }
          g.lineTo(ox + plotW, oy)
          g.closePath()
          g.fillStyle = '#0b0d10'
          g.fill()
          const [r, gg, bb] = heat(1 - age * 0.85)
          g.strokeStyle = `rgb(${r | 0},${gg | 0},${bb | 0})`
          g.lineWidth = (idx === history.length - 1 ? 1.5 : 1) * dpr
          g.stroke()
        })
        return
      }

      if (mode === 'spectrogram') {
        if (!s) return
        if (!ring || ring.width !== w || ring.height !== h) {
          ring = g.createImageData(w, h)
          ringPos = 0
        }
        if (!rowBins || rowBins.length !== h + 1) {
          rowBins = new Int32Array(h + 1)
          for (let y = 0; y <= h; y++) {
            const f = 20 * Math.pow(1000, 1 - y / h)
            rowBins[y] = Math.max(1, Math.min(s.data.length - 1, Math.round((f * s.fftSize) / s.sampleRate)))
          }
        }
        for (let y = 0; y < h; y++) {
          // Max over the bins this pixel row covers (rows near the top span many bins)
          const a = rowBins[y + 1]
          const b = rowBins[y]
          let m = -200
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (s.data[i] > m) m = s.data[i]
          const [r, gg, bb] = heat((m - floorDb) / range)
          const o = (y * w + ringPos) * 4
          ring.data[o] = r
          ring.data[o + 1] = gg
          ring.data[o + 2] = bb
          ring.data[o + 3] = 255
        }
        ringPos = (ringPos + 1) % w
        // Oldest column (ringPos) at the left edge, newest at the right
        g.putImageData(ring, -ringPos, 0, ringPos, 0, w - ringPos, h)
        if (ringPos > 0) g.putImageData(ring, w - ringPos, 0, 0, 0, ringPos, h)
        return
      }

      g.clearRect(0, 0, w, h)
      // grid
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.fillStyle = css.getPropertyValue('--st-muted')
      g.lineWidth = 1
      for (const f of FREQ_LABELS) {
        const x = fx(f, w)
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, h)
        g.stroke()
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, h - 4)
      }
      const step = range > 80 ? 20 : 10
      for (let db = 0; db >= floorDb; db -= step) {
        const y = yOf(db)
        g.beginPath()
        g.moveTo(0, y)
        g.lineTo(w, y)
        g.stroke()
        g.fillText(`${db}`, 3, y + 12)
      }
      if (!s) return

      if (mode === 'rta') {
        if (!linear || linear.length !== s.data.length) linear = new Float32Array(s.data.length)
        for (let i = 0; i < s.data.length; i++) linear[i] = Math.pow(10, s.data[i] / 10)
        const bands = thirdOctavePower(linear, s.sampleRate, s.fftSize, RTA_CENTERS, 'sum')
        if (rtaPeaks.length !== bands.length) rtaPeaks = bands.map(() => -200)
        const bw = w / bands.length
        bands.forEach((p, i) => {
          const db = p > 0 ? 10 * Math.log10(p) : -200
          rtaPeaks[i] = Math.max(db, rtaPeaks[i] - 0.35)
          const x = i * bw + bw * 0.12
          const y = yOf(db)
          const grad = g.createLinearGradient(0, h, 0, 0)
          grad.addColorStop(0, '#2fbf6a')
          grad.addColorStop(0.75, '#ffd84d')
          grad.addColorStop(1, '#ff4d5e')
          g.fillStyle = grad
          g.fillRect(x, y, bw * 0.76, h - y)
          g.fillStyle = css.getPropertyValue('--st-warn')
          g.fillRect(x, yOf(rtaPeaks[i]) - 1.5 * dpr, bw * 0.76, 2 * dpr)
          if (i % 3 === 0) {
            g.fillStyle = css.getPropertyValue('--st-text')
            const f = RTA_CENTERS[i]
            g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, 12 * dpr)
          }
        })
        return
      }

      // ---- FFT line
      if (!peaks || peaks.length !== s.data.length) peaks = new Float32Array(s.data.length).fill(-120)
      if (reference && reference.length === s.data.length) {
        g.beginPath()
        let rx = -1
        for (let i = 1; i < reference.length; i++) {
          const f = (i * s.sampleRate) / s.fftSize
          if (f < 20 || f > 20000) continue
          const x = fx(f, w)
          if (x - rx < 2) continue
          rx = x
          g.lineTo(x, yOf(reference[i]))
        }
        g.strokeStyle = css.getPropertyValue('--st-ref') || '#b48cff'
        g.lineWidth = 1.5 * dpr
        g.setLineDash([6 * dpr, 4 * dpr])
        g.stroke()
        g.setLineDash([])
        g.lineWidth = 1
      }
      g.beginPath()
      g.moveTo(0, h)
      let lastX = -1
      for (let i = 1; i < s.data.length; i++) {
        const f = (i * s.sampleRate) / s.fftSize
        if (f < 20 || f > 20000) continue
        const db = s.data[i]
        peaks[i] = Math.max(db, peaks[i] - 0.4)
        const x = fx(f, w)
        if (x - lastX < 1) continue
        lastX = x
        g.lineTo(x, yOf(db))
      }
      g.lineTo(w, h)
      g.closePath()
      const grad = g.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, css.getPropertyValue('--st-accent'))
      grad.addColorStop(1, 'transparent')
      g.fillStyle = grad
      g.globalAlpha = 0.55
      g.fill()
      g.globalAlpha = 1
      g.strokeStyle = css.getPropertyValue('--st-accent')
      g.stroke()
      // peak hold line
      g.beginPath()
      lastX = -1
      for (let i = 1; i < peaks.length; i++) {
        const f = (i * s.sampleRate) / s.fftSize
        if (f < 20 || f > 20000) continue
        const x = fx(f, w)
        if (x - lastX < 2) continue
        lastX = x
        g.lineTo(x, yOf(peaks[i]))
      }
      g.strokeStyle = css.getPropertyValue('--st-warn')
      g.globalAlpha = 0.7
      g.stroke()
      g.globalAlpha = 1

      // hover cursor: frequency, note and level under the mouse
      const mx = mouse.current
      if (mx !== null) {
        const x = mx * dpr
        const f = fOfX(x, w)
        const bin = Math.max(1, Math.min(s.data.length - 1, Math.round((f * s.fftSize) / s.sampleRate)))
        const db = s.data[bin]
        g.strokeStyle = css.getPropertyValue('--st-text')
        g.globalAlpha = 0.5
        g.beginPath()
        g.moveTo(x, 0)
        g.lineTo(x, h)
        g.stroke()
        g.globalAlpha = 1
        const label = `${fmtHz(f)} Hz · ${noteName(f)} · ${db.toFixed(1)} dB`
        const tw = g.measureText(label).width + 10 * dpr
        const tx = x + tw + 8 > w ? x - tw - 6 : x + 6
        g.fillStyle = 'rgba(0,0,0,0.75)'
        g.fillRect(tx, 6 * dpr, tw, 18 * dpr)
        g.fillStyle = css.getPropertyValue('--st-text')
        g.fillText(label, tx + 5 * dpr, 19 * dpr)
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="st-spectrum" style={{ height }}>
      <canvas
        ref={canvas}
        className="st-canvas"
        style={{ height }}
        onMouseMove={(e) => (mouse.current = e.nativeEvent.offsetX)}
        onMouseLeave={() => (mouse.current = null)}
      />
      {mode === 'spectrogram' && (
        <div className="st-spectro-labels">
          {[20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50].map((f) => (
            <span key={f} style={{ top: `${(1 - Math.log10(f / 20) / 3) * 100}%` }}>
              {f >= 1000 ? `${f / 1000}k` : f}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Oscilloscope of the analyser frame, triggered on a rising zero crossing so waves stand still */
export function ScopeCanvas({ height = 120 }: { height?: number }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let raf = 0
    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const data = audioEngine.waveform()
      if (!c) return
      const [w, h] = fitCanvas(c)
      const g = c.getContext('2d')!
      const css = getComputedStyle(c)
      g.clearRect(0, 0, w, h)
      g.strokeStyle = css.getPropertyValue('--st-grid')
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, h / 2)
      g.lineTo(w, h / 2)
      g.stroke()
      if (!data) return
      const span = Math.floor(data.length / 2)
      let start = 0
      for (let i = 1; i < data.length - span; i++) {
        if (data[i - 1] < 0 && data[i] >= 0) {
          start = i
          break
        }
      }
      g.strokeStyle = css.getPropertyValue('--st-ok')
      g.lineWidth = 1.5 * devicePixelRatio
      g.beginPath()
      for (let i = 0; i < span; i++) {
        const x = (i / (span - 1)) * w
        const y = h / 2 - data[start + i] * (h / 2)
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [])
  return <canvas ref={canvas} className="st-canvas" style={{ height }} />
}
