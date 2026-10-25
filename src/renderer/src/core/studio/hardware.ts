import type { AudioProfile } from '../audio/AudioConfig'

// Hardware inventory helpers: what a device says it supports, which profile belongs to
// which device, and when to switch profiles because a device was plugged or unplugged.

export interface DeviceProbe {
  /** What the browser opened (settings) */
  channels: number | null
  sampleRate: number | null
  latencyMs: number | null
  /** Ranges the device reports (capabilities); null = not reported */
  channelRange: [number, number] | null
  sampleRateRange: [number, number] | null
  /** Windows processing that can be turned off */
  processing: string[]
}

type Range = { min?: number; max?: number } | undefined

function range(r: Range): [number, number] | null {
  return r && typeof r.min === 'number' && typeof r.max === 'number' ? [r.min, r.max] : null
}

/** Normalizes MediaTrackCapabilities + MediaTrackSettings into something printable */
export function probeFrom(caps: Record<string, unknown>, settings: Record<string, unknown>): DeviceProbe {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const processing: string[] = []
  const has = (k: string): boolean => Array.isArray(caps[k]) && (caps[k] as unknown[]).length > 0
  if (has('echoCancellation')) processing.push('cancelación de eco')
  if (has('noiseSuppression')) processing.push('supresión de ruido')
  if (has('autoGainControl')) processing.push('ganancia automática')
  const latency = num(settings.latency)
  return {
    channels: num(settings.channelCount),
    sampleRate: num(settings.sampleRate),
    latencyMs: latency === null ? null : Math.round(latency * 10000) / 10,
    channelRange: range(caps.channelCount as Range),
    sampleRateRange: range(caps.sampleRate as Range),
    processing
  }
}

/** One-line description of a probed device */
export function describeProbe(p: DeviceProbe): string {
  const parts: string[] = []
  if (p.channels !== null) parts.push(`${p.channels} canal${p.channels === 1 ? '' : 'es'}${p.channelRange && p.channelRange[1] > p.channels ? ` (hasta ${p.channelRange[1]})` : ''}`)
  if (p.sampleRate !== null) parts.push(`${p.sampleRate / 1000} kHz`)
  if (p.sampleRateRange && p.sampleRateRange[0] !== p.sampleRateRange[1]) parts.push(`admite ${p.sampleRateRange[0] / 1000}–${p.sampleRateRange[1] / 1000} kHz`)
  if (p.latencyMs !== null) parts.push(`latencia ${p.latencyMs} ms`)
  return parts.join(' · ') || 'Sin información del dispositivo'
}

export function profilesForDevice(profiles: AudioProfile[], deviceId: string): AudioProfile[] {
  return profiles.filter((p) => p.deviceId === deviceId)
}

/**
 * Profile to switch to after the device list changed, or null to stay. Leaves the active
 * profile alone while its device is present; otherwise prefers a profile whose device was
 * just plugged in, then any profile with a present device, then the default-input profile.
 */
export function autoProfileSwitch(profiles: AudioProfile[], activeId: string, present: string[], added: string[] = []): string | null {
  const active = profiles.find((p) => p.id === activeId)
  const usable = (p: AudioProfile): boolean => p.deviceId === null || present.includes(p.deviceId)
  // A freshly plugged device with its own profile wins over the generic default input
  const plugged = profiles.find((p) => p.deviceId !== null && added.includes(p.deviceId))
  if (plugged && plugged.id !== activeId && (!active || active.deviceId === null || !usable(active))) return plugged.id
  if (active && usable(active)) return null
  const other = profiles.find((p) => p.id !== activeId && p.deviceId !== null && present.includes(p.deviceId)) ?? profiles.find((p) => p.id !== activeId && p.deviceId === null)
  return other ? other.id : null
}

/** Profile name from a device label: drops the "(1234:abcd)" USB id Windows appends */
export function profileNameFor(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || 'Equipo'
}

/** Semicolon CSV (Spanish Excel) with a BOM */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number): string => `"${(typeof v === 'number' ? (Number.isFinite(v) ? String(v).replace('.', ',') : '') : v).replace(/"/g, '""')}"`
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n')
}
