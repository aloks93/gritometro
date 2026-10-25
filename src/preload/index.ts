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
    printPdf: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('file:printPdf', defaultName)
  }
}

export type GritometroApi = typeof api

contextBridge.exposeInMainWorld('gritometro', api)
