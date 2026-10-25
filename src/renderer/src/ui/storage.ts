import type { GritometroApi } from '../../../preload'

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

export async function saveFile(name: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string | null> {
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
