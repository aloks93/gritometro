import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { dataPath, readKey, writeKey } from './storage'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1f3a',
    title: 'Gritómetro',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      // The meter must keep sampling even if the window loses focus
      backgroundThrottling: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function setupPermissions(): void {
  // Microphone (and webcam for the winner photo) are the whole point of the app
  const allowed = new Set(['media', 'mediaKeySystem', 'speaker-selection'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
}

function setupIpc(): void {
  ipcMain.handle('storage:get', (_e, key: string) => readKey(key))
  ipcMain.handle('storage:set', (_e, key: string, value: unknown) => writeKey(key, value))
  ipcMain.handle('storage:path', () => dataPath())

  ipcMain.handle('window:toggleFullscreen', () => {
    if (!mainWindow) return false
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return mainWindow.isFullScreen()
  })

  ipcMain.handle(
    'file:save',
    async (_e, defaultName: string, content: string, encoding: 'utf8' | 'base64') => {
      if (!mainWindow) return null
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName })
      if (canceled || !filePath) return null
      await fs.writeFile(filePath, Buffer.from(content, encoding))
      return filePath
    }
  )

  ipcMain.handle('file:open', async (_e, extensions: string[]) => {
    if (!mainWindow) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Archivos', extensions }]
    })
    if (canceled || filePaths.length === 0) return null
    return fs.readFile(filePaths[0], 'utf8')
  })

  ipcMain.handle('file:printPdf', async (_e, defaultName: string) => {
    if (!mainWindow) return null
    const pdf = await mainWindow.webContents.printToPDF({ landscape: true, printBackground: true })
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, pdf)
    return filePath
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  setupPermissions()
  setupIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
