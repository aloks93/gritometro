import { saveFile } from '../storage'

/**
 * Saves a canvas as PNG on a dark background (the studio canvases are transparent),
 * named with the date so successive captures don't overwrite each other.
 */
export async function saveCanvasPng(canvas: HTMLCanvasElement | null, name: string): Promise<string | null> {
  if (!canvas || canvas.width === 0) return null
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = canvas.height
  const g = out.getContext('2d')!
  g.fillStyle = '#0b0d10'
  g.fillRect(0, 0, out.width, out.height)
  g.drawImage(canvas, 0, 0)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const b64 = out.toDataURL('image/png').split(',')[1]
  return saveFile(`${name}-${stamp}.png`, b64, 'base64')
}
