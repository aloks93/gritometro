import { describe, expect, it } from 'vitest'
import { createProfile } from '../audio/AudioConfig'
import { autoProfileSwitch, describeProbe, probeFrom, profileNameFor, profilesForDevice, toCsv } from './hardware'

describe('device probe', () => {
  it('reads settings and capability ranges', () => {
    const p = probeFrom(
      { channelCount: { min: 1, max: 8 }, sampleRate: { min: 44100, max: 96000 }, echoCancellation: [true, false], noiseSuppression: [] },
      { channelCount: 2, sampleRate: 48000, latency: 0.0106 }
    )
    expect(p).toMatchObject({ channels: 2, sampleRate: 48000, latencyMs: 10.6, channelRange: [1, 8], sampleRateRange: [44100, 96000], processing: ['cancelación de eco'] })
    expect(describeProbe(p)).toBe('2 canales (hasta 8) · 48 kHz · admite 44.1–96 kHz · latencia 10.6 ms')
    expect(describeProbe(probeFrom({}, {}))).toMatch(/Sin información/)
  })

  it('cleans Windows USB ids from names', () => {
    expect(profileNameFor('Micrófono (Scarlett 2i2 USB) (1235:8210)')).toBe('Micrófono (Scarlett 2i2 USB)')
    expect(profileNameFor('  ')).toBe('Equipo')
  })
})

describe('automatic profile switching', () => {
  const laptop = createProfile('Laptop', { id: 'p-laptop' })
  const usb = createProfile('USB', { id: 'p-usb', deviceId: 'dev-usb' })
  const iface = createProfile('Interfaz', { id: 'p-if', deviceId: 'dev-if' })
  const all = [laptop, usb, iface]

  it('stays while the active device is present', () => {
    expect(autoProfileSwitch(all, 'p-usb', ['dev-usb', 'dev-if'])).toBeNull()
    expect(autoProfileSwitch(all, 'p-laptop', ['dev-usb'])).toBeNull()
  })

  it('moves to a present device when the active one is unplugged', () => {
    expect(autoProfileSwitch(all, 'p-usb', ['dev-if'])).toBe('p-if')
    expect(autoProfileSwitch(all, 'p-usb', [])).toBe('p-laptop')
  })

  it('a newly plugged device with its own profile takes over the default input', () => {
    expect(autoProfileSwitch(all, 'p-laptop', ['dev-if'], ['dev-if'])).toBe('p-if')
    // …but never steals the place of another real device that is still connected
    expect(autoProfileSwitch(all, 'p-usb', ['dev-usb', 'dev-if'], ['dev-if'])).toBeNull()
    expect(profilesForDevice(all, 'dev-if').map((p) => p.id)).toEqual(['p-if'])
  })
})

describe('csv', () => {
  it('uses semicolons, decimal commas and escapes quotes', () => {
    const csv = toCsv([
      ['a', 'b "c"'],
      [1.5, -Infinity]
    ])
    expect(csv).toBe('﻿"a";"b ""c"""\r\n"1,5";""')
  })
})
