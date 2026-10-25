import type { GritometroApi } from '../../../preload'
import { localizeCsv, localizeHtml } from './studio/i18n'

declare global {
  interface Window {
    gritometro?: GritometroApi
  }
}

export const api = (): GritometroApi | undefined => window.gritometro

// Falls back to localStorage so the UI also runs in a plain browser (vite preview, tests)
export async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const a = api()
    const value = a ? await a.storage.get(key) : JSON.parse(localStorage.getItem(`grit:${key}`) ?? 'null')
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

export async function save(key: string, value: unknown): Promise<void> {
  try {
    const a = api()
    if (a) await a.storage.set(key, value)
    else localStorage.setItem(`grit:${key}`, JSON.stringify(value))
  } catch (err) {
    console.error('No se pudo guardar', key, err)
  }
}

// Coalesces rapid updates (typing a name, dragging a slider) into one write per key.
// Writes for the same key are chained so an older value can never land after a newer one.
const pending = new Map<string, { value: unknown; timer: ReturnType<typeof setTimeout> }>()
const chains = new Map<string, Promise<void>>()

function flushKey(key: string): Promise<void> {
  const p = pending.get(key)
  if (!p) return chains.get(key) ?? Promise.resolve()
  clearTimeout(p.timer)
  pending.delete(key)
  const next = (chains.get(key) ?? Promise.resolve()).then(() => save(key, p.value))
  chains.set(key, next)
  return next
}

export function saveDebounced(key: string, value: unknown, ms = 250): void {
  const prev = pending.get(key)
  if (prev) clearTimeout(prev.timer)
  pending.set(key, { value, timer: setTimeout(() => void flushKey(key), ms) })
}

/** Writes everything still waiting (called before the window closes) */
export function flushSaves(): Promise<void> {
  return Promise.all([...pending.keys()].map(flushKey)).then(() => undefined)
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => void flushSaves())

export async function saveFile(name: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string | null> {
  // Exported tables follow the studio language
  if (encoding === 'utf8' && /\.csv$/i.test(name)) content = localizeCsv(content)
  const a = api()
  if (a) return a.file.save(name, content, encoding)
  const blob =
    encoding === 'base64'
      ? new Blob([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))])
      : new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
  return name
}

export async function openTextFile(extensions: string[]): Promise<string | null> {
  const a = api()
  if (a) return a.file.open(extensions)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = extensions.map((e) => `.${e}`).join(',')
    input.onchange = async () => resolve(input.files?.[0] ? await input.files[0].text() : null)
    input.click()
  })
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out.buffer
}

/** Standalone HTML → PDF (Electron), or the browser's print dialog as a fallback */
export async function saveHtmlAsPdf(name: string, html: string): Promise<string | null> {
  html = localizeHtml(html)
  const a = api()
  if (a) return a.file.htmlToPdf(name, html)
  const w = window.open('', '_blank')
  if (!w) return null
  w.document.write(html)
  w.document.close()
  w.print()
  return name
}

export async function openBinaryFiles(extensions: string[]): Promise<{ name: string; data: ArrayBuffer }[]> {
  const a = api()
  if (a) {
    const files = await a.file.openBinary(extensions)
    return (files ?? []).map((f) => ({ name: f.name, data: fromBase64(f.base64) }))
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = extensions.map((e) => `.${e}`).join(',')
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))))
    input.click()
  })
}

/**
 * Reads an image scaled down to `maxSide` px, so photos straight from a phone (several MB)
 * don't bloat the saved JSON. GIF/SVG keep their original data (animation/vector).
 */
export async function readImageScaled(file: File, maxSide: number, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<string> {
  if (/gif|svg/i.test(file.type)) return readFileAsDataUrl(file)
  try {
    const bitmap = await createImageBitmap(file)
    const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * k))
    canvas.height = Math.max(1, Math.round(bitmap.height * k))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const scaled = canvas.toDataURL(type, 0.86)
    // Already-small files may grow when re-encoded: keep whichever is smaller
    return scaled.length < file.size * 1.37 ? scaled : readFileAsDataUrl(file)
  } catch {
    return readFileAsDataUrl(file)
  }
}
