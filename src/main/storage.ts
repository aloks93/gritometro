import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

// Each key is stored as its own JSON file in <userData>/data/<key>.json
const KEY_PATTERN = /^[a-z0-9-]+$/i

function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}

function fileFor(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`Clave de almacenamiento inválida: ${key}`)
  return join(dataDir(), `${key}.json`)
}

export async function readKey(key: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(fileFor(key), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// One write at a time per key: concurrent writes used to share the .tmp file and could
// rename a half-written file or fail with ENOENT
const queues = new Map<string, Promise<void>>()

export function writeKey(key: string, value: unknown): Promise<void> {
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => writeNow(key, value))
  queues.set(key, run)
  return run
}

async function writeNow(key: string, value: unknown): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  const target = fileFor(key)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  // Write-then-rename so a crash mid-party never corrupts the records file
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8')
  await fs.rename(tmp, target)
}

export function dataPath(): string {
  return dataDir()
}
