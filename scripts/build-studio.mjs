// Builds the standalone "Gritómetro Studio" in dist-studio/: Windows installer + portable by
// default, or the macOS dmg/zip with --mac. Same code as the party app, compiled with GRIT_EDITION=studio.
import { execSync } from 'node:child_process'

const env = { ...process.env, GRIT_EDITION: 'studio' }
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env })

run('npx electron-vite build')
const platform = process.argv.includes('--mac') ? '--mac' : '--win'
run(`npx electron-builder ${platform} --config electron-builder.studio.yml --publish never`)
