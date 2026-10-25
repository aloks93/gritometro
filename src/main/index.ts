import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { dataPath, readKey, writeKey } from './storage'

let mainWindow: BrowserWindow | null = null
const STUDIO = __EDITION__ === 'studio'

// The standalone studio keeps its own data folder so it never touches the party app's records
if (STUDIO) {
  app.setName('Gritometro Studio')
  app.setPath('userData', join(app.getPath('appData'), 'Gritometro Studio'))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: STUDIO ? '#0d0f12' : '#0b1f3a',
    title: STUDIO ? 'Gritómetro Studio' : 'Gritómetro',
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

  // Studio report: render standalone HTML off-screen and print it, without touching the app window
  ipcMain.handle('file:htmlToPdf', async (_e, defaultName: string, html: string) => {
    if (!mainWindow) return null
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const pdf = await win.webContents.printToPDF({ landscape: true, printBackground: true, pageSize: 'A4' })
      await fs.writeFile(filePath, pdf)
      return filePath
    } finally {
      win.destroy()
    }
  })

  ipcMain.handle('file:openBinary', async (_e, extensions: string[]) => {
    if (!mainWindow) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions }]
    })
    if (canceled || filePaths.length === 0) return null
    return Promise.all(filePaths.map(async (p) => ({ name: basename(p), base64: (await fs.readFile(p)).toString('base64') })))
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
