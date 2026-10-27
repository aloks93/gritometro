// Builds the standalone "Gritómetro Procesador de Audio" in dist-procesador/: Windows installer + portable by
// default, or the macOS dmg/zip with --mac. Same code as the party app, compiled with GRIT_EDITION=processor.
import { execSync } from 'node:child_process'

const env = { ...process.env, GRIT_EDITION: 'processor' }
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env })

run('npx electron-vite build')
const platform = process.argv.includes('--mac') ? '--mac' : '--win'
run(`npx electron-builder ${platform} --config electron-builder.processor.yml --publish never`)
