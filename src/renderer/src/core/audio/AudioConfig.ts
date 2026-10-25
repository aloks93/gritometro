// Audio configuration: a "simple" mode (just pick a mic) and an "advanced" mode
// for VoiceMeeter Banana, USB mixing consoles and multichannel interfaces.

export type Ballistics = 'fast' | 'vu' | 'peak'
export type LatencyHint = 'interactive' | 'balanced' | 'playback'

export interface AudioProfile {
  id: string
  name: string
  /** null = system default input */
  deviceId: string | null
  /** 'mix' = downmix all channels; number = 0-based channel index on multichannel devices */
  channel: 'mix' | number
  /** Turn off echo cancellation, noise suppression and auto gain (needed for honest measurements) */
  disableProcessing: boolean
  /** Digital trim applied before measuring, in dB */
  gainDb: number
  /** Readings below this dBFS are treated as silence */
  gateDb: number
  ballistics: Ballistics
  /** dB SPL ≈ dBFS + splOffset (adjust against a phone sound meter app) */
  splOffset: number
  /** null = let the device decide */
  sampleRate: number | null
  latency: LatencyHint
  /** Measured ambient noise, dBFS */
  noiseFloorDb: number
}

export interface AudioSettings {
  mode: 'simple' | 'advanced'
  activeProfileId: string
  profiles: AudioProfile[]
  /** Show dBFS / RMS / peak / spectrum to the operator */
  showTechnicalMeter: boolean
}

export function createProfile(name: string, overrides: Partial<AudioProfile> = {}): AudioProfile {
  return {
    id: `perfil-${Math.random().toString(36).slice(2, 9)}`,
    name,
    deviceId: null,
    channel: 'mix',
    disableProcessing: true,
    gainDb: 0,
    gateDb: -75,
    ballistics: 'fast',
    splOffset: 110,
    sampleRate: null,
    latency: 'interactive',
    noiseFloorDb: -60,
    ...overrides
  }
}

export function defaultAudioSettings(): AudioSettings {
  const laptop = createProfile('Laptop', { id: 'perfil-laptop' })
  return {
    mode: 'simple',
    activeProfileId: laptop.id,
    profiles: [laptop],
    showTechnicalMeter: false
  }
}

export function activeProfile(settings: AudioSettings): AudioProfile {
  return settings.profiles.find((p) => p.id === settings.activeProfileId) ?? settings.profiles[0]
}

/**
 * In simple mode only the device and noise floor are user-controlled;
 * every other knob falls back to safe defaults so a stale advanced tweak can't break the party.
 */
export function effectiveProfile(settings: AudioSettings): AudioProfile {
  const p = activeProfile(settings)
  if (settings.mode === 'advanced') return p
  return createProfile(p.name, { id: p.id, deviceId: p.deviceId, noiseFloorDb: p.noiseFloorDb })
}

const VIRTUAL_PATTERNS = [/voicemeeter/i, /vb-audio/i, /vaio/i, /cable output/i, /stereo mix/i, /mezcla estéreo/i]

export function isVirtualDevice(label: string): boolean {
  return VIRTUAL_PATTERNS.some((r) => r.test(label))
}
