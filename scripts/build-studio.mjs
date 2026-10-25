// Builds the standalone "Gritómetro Studio" (Windows installer + portable in dist-studio/).
// Same code as the party app, compiled with GRIT_EDITION=studio.
import { execSync } from 'node:child_process'

const env = { ...process.env, GRIT_EDITION: 'studio' }
const run = (cmd) => execSync(cmd, { stdio: 'inherit', env })

run('npx electron-vite build')
run('npx electron-builder --win --config electron-builder.studio.yml')
