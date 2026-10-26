// Writes the plugin's data from the app's code, so app and plugin never drift apart:
// - plugin/presets.json: the presets the VST/CLAP plugin offers (every use × mic)
// - plugin/tests/parity.json: the app chain's output for a test signal; `cargo test` checks the
//   plugin's DSP produces the same samples
// Run after changing presets or the processor DSP: npm run plugin:presets
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'grit-presets-'))
const load = async (entry, name) => {
  const out = join(dir, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' })
  return import(pathToFileURL(out).href)
}
try {
  const { pluginPresetBundle, serializeBundle } = await load('src/renderer/src/core/processor/pluginPresets.ts', 'presets')
  const bundle = pluginPresetBundle()
  writeFileSync('plugin/presets.json', serializeBundle(bundle))
  console.log(`plugin/presets.json: ${bundle.uses.length} uses, ${Object.keys(bundle.chains).length} chains`)

  const { parityFixture } = await load('src/renderer/src/core/processor/pluginParity.ts', 'parity')
  mkdirSync('plugin/tests', { recursive: true })
  const fixture = parityFixture()
  writeFileSync('plugin/tests/parity.json', JSON.stringify(fixture) + '\n')
  console.log(`plugin/tests/parity.json: ${fixture.cases.length} cases`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
