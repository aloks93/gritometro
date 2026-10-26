import { buildPreset, MIC_GROUPS, MICS, micsFor, USE_GROUPS, useGroupOf, USES, type ProcessingChain } from './processor'

// Everything the VST/CLAP plugin (plugin/) needs to offer the same presets as the app:
// uses, microphones and the chain of every use × mic. Written to plugin/presets.json by
// `npm run plugin:presets`; a test fails when the file is out of date.

export interface PluginPresetBundle {
  groups: [string, string][]
  micGroups: [string, string][]
  uses: { id: string; name: string; hint: string; group: string; defaultMic: string; mics: string[] }[]
  mics: { id: string; name: string; hint: string; group: string }[]
  chains: Record<string, ProcessingChain>
}

export function pluginPresetBundle(): PluginPresetBundle {
  const chains: Record<string, ProcessingChain> = {}
  for (const u of USES) for (const m of micsFor(u.id)) chains[`${u.id}|${m.id}`] = buildPreset(u.id, m.id)
  return {
    groups: USE_GROUPS.map(([id, label]) => [id, label]),
    micGroups: MIC_GROUPS.map(([id, label]) => [id, label]),
    uses: USES.map((u) => ({ id: u.id, name: u.name, hint: u.hint, group: useGroupOf(u), defaultMic: u.defaultMic, mics: micsFor(u.id).map((m) => m.id) })),
    mics: MICS.map((m) => ({ id: m.id, name: m.name, hint: m.hint, group: m.group })),
    chains
  }
}

export const serializeBundle = (b: PluginPresetBundle): string => JSON.stringify(b) + '\n'
