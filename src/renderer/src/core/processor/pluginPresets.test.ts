import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { pluginPresetBundle, serializeBundle } from './pluginPresets'

describe('plugin presets', () => {
  it('plugin/presets.json matches the app presets (run npm run plugin:presets after changing them)', () => {
    const file = readFileSync('plugin/presets.json', 'utf8').replace(/\r\n/g, '\n')
    expect(file).toBe(serializeBundle(pluginPresetBundle()))
  })

  it('every use has its default mic and a chain for each of its mics', () => {
    const b = pluginPresetBundle()
    for (const u of b.uses) {
      expect(u.mics).toContain(u.defaultMic)
      for (const m of u.mics) expect(b.chains[`${u.id}|${m}`], `${u.id}|${m}`).toBeDefined()
    }
    expect(b.uses.some((u) => u.id === 'recorded')).toBe(true)
  })
})
