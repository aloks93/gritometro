// Renders an SVG to a square PNG with Electron (no extra dependencies):
//   npx electron scripts/render-icon.cjs build/processor/icon.svg build/processor/icon.png 1024
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('fs')
const { resolve } = require('path')

const [svgPath, pngPath, sizeArg] = process.argv.slice(-3)
const size = Number(sizeArg) || 1024

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = readFileSync(resolve(svgPath), 'utf8')
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  const html = `<html><body style="margin:0;overflow:hidden;background:transparent"><img style="position:fixed;left:0;top:0;width:100vmin;height:100vmin" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 400))
  // The window may not be exactly square (display scaling): crop the square the image fills
  const image = await win.webContents.capturePage()
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  const square = image.crop({ x: 0, y: 0, width: side, height: side })
  writeFileSync(resolve(pngPath), square.resize({ width: size, height: size, quality: 'best' }).toPNG())
  console.log(`wrote ${pngPath} (${size}×${size})`)
  app.quit()
})
