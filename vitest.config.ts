import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') }
  },
  define: { __EDITION__: JSON.stringify('party') },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
