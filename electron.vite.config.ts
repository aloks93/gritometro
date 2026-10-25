import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// GRIT_EDITION=studio builds the standalone "Gritómetro Studio" from the same code
const edition = process.env.GRIT_EDITION === 'studio' ? 'studio' : 'party'
const define = { __EDITION__: JSON.stringify(edition) }

export default defineConfig({
  main: {
    define,
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    define,
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
