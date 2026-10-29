import { contextBridge, ipcRenderer } from 'electron'

const api = {
  storage: {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('storage:get', key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('storage:set', key, value),
    path: (): Promise<string> => ipcRenderer.invoke('storage:path')
  },
  window: {
    toggleFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:toggleFullscreen')
  },
  file: {
    save: (defaultName: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string | null> =>
      ipcRenderer.invoke('file:save', defaultName, content, encoding),
    open: (extensions: string[]): Promise<string | null> => ipcRenderer.invoke('file:open', extensions),
    printPdf: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('file:printPdf', defaultName),
    htmlToPdf: (defaultName: string, html: string): Promise<string | null> => ipcRenderer.invoke('file:htmlToPdf', defaultName, html),
    openBinary: (extensions: string[], filterName?: string): Promise<{ name: string; base64: string }[] | null> =>
      ipcRenderer.invoke('file:openBinary', extensions, filterName),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path)
  },
  /** Multitrack recording streamed to disk (one WAV per track) */
  rec: {
    chooseDir: (current: string | null): Promise<string | null> => ipcRenderer.invoke('rec:chooseDir', current),
    open: (dir: string, folderName: string, tracks: { file: string; channels: number }[], sampleRate: number, format: 16 | 24 | 'float'): Promise<{ id: number; folder: string }> =>
      ipcRenderer.invoke('rec:open', dir, folderName, tracks, sampleRate, format),
    write: (id: number, track: number, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('rec:write', id, track, data),
    close: (id: number, extras?: { name: string; content: string }[]): Promise<{ folder: string; bytes: number; errors: string[] } | null> => ipcRenderer.invoke('rec:close', id, extras)
  }
}

export type GritometroApi = typeof api

contextBridge.exposeInMainWorld('gritometro', api)
