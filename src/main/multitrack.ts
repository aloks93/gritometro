import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { join } from 'path'
import type { WavFormat } from '../renderer/src/core/studio/analysis'
import { safeName, WAV_HEADER_BYTES, wavHeader, wavSizes } from '../renderer/src/core/studio/multitrack'

// Multitrack recording straight to disk: one WAV per track, written as chunks arrive so a long
// session never has to fit in memory. Sizes in the headers are patched when the take ends.

interface TrackFile {
  path: string
  handle: FileHandle
  bytes: number
  /** Writes of one file happen strictly in arrival order */
  chain: Promise<void>
  error?: string
}

interface Take {
  folder: string
  tracks: TrackFile[]
}

const takes = new Map<number, Take>()
let nextId = 1

export function setupMultitrackIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('rec:chooseDir', async (_e, current: string | null) => {
    const win = getWindow()
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Carpeta para las grabaciones multipista',
      defaultPath: current ?? undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return canceled || !filePaths[0] ? null : filePaths[0]
  })

  ipcMain.handle(
    'rec:open',
    async (_e, dir: string, folderName: string, tracks: { file: string; channels: number }[], sampleRate: number, format: WavFormat) => {
      const folder = join(dir, safeName(folderName, 'Multipista'))
      await fs.mkdir(folder, { recursive: true })
      const opened: TrackFile[] = []
      try {
        for (const t of tracks) {
          const path = join(folder, t.file)
          const handle = await fs.open(path, 'w')
          await handle.write(wavHeader(format, t.channels, sampleRate, 0), 0, WAV_HEADER_BYTES, 0)
          opened.push({ path, handle, bytes: 0, chain: Promise.resolve() })
        }
      } catch (err) {
        await Promise.all(opened.map((t) => t.handle.close().catch(() => undefined)))
        throw err
      }
      const id = nextId++
      takes.set(id, { folder, tracks: opened })
      return { id, folder }
    }
  )

  ipcMain.handle('rec:write', (_e, id: number, track: number, data: Uint8Array) => {
    const t = takes.get(id)?.tracks[track]
    if (!t) return false
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    t.chain = t.chain.then(async () => {
      if (t.error) return
      try {
        await t.handle.write(buf, 0, buf.length, WAV_HEADER_BYTES + t.bytes)
        t.bytes += buf.length
      } catch (err) {
        t.error = err instanceof Error ? err.message : String(err)
      }
    })
    return true
  })

  /** Finishes a take: waits for pending writes, patches the sizes, writes extra text files */
  ipcMain.handle('rec:close', async (_e, id: number, extras: { name: string; content: string }[] = []) => {
    const take = takes.get(id)
    if (!take) return null
    takes.delete(id)
    const errors: string[] = []
    let total = 0
    for (const t of take.tracks) {
      await t.chain
      try {
        const s = wavSizes(t.bytes)
        await t.handle.write(s.riff, 0, 4, 4)
        await t.handle.write(s.data, 0, 4, 40)
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      if (t.error) errors.push(t.error)
      await t.handle.close().catch(() => undefined)
      total += WAV_HEADER_BYTES + t.bytes
    }
    for (const x of extras) await fs.writeFile(join(take.folder, safeName(x.name, 'sesion.txt')), x.content, 'utf8').catch((err) => errors.push(String(err)))
    return { folder: take.folder, bytes: total, errors }
  })

  ipcMain.handle('shell:openPath', (_e, path: string) => shell.openPath(path))
}
