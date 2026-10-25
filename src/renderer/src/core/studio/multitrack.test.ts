import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWavChannels } from './analysis'
import { bytesPerSecond, fmtTimecode, pcmBytes, safeName, sessionFolderName, trackFileNames, wavHeader, wavSizes } from './multitrack'

/** Header + PCM written in pieces, then sizes patched: what the main process does on disk */
function streamed(chunks: Float32Array[][], format: 16 | 24 | 'float', channels: number, sr: number): ArrayBuffer {
  const parts = chunks.map((c) => pcmBytes(c, format))
  const data = parts.reduce((n, p) => n + p.length, 0)
  const file = new Uint8Array(44 + data)
  file.set(wavHeader(format, channels, sr, 0), 0)
  let o = 44
  for (const p of parts) {
    file.set(p, o)
    o += p.length
  }
  const sizes = wavSizes(data)
  file.set(sizes.riff, 4)
  file.set(sizes.data, 40)
  return file.buffer
}

describe('multitrack files', () => {
  it('a streamed WAV is byte-identical to one encoded in one go', () => {
    const l = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.8)
    const r = Float32Array.from({ length: 1000 }, (_, i) => Math.cos(i / 5) * 0.5)
    for (const f of [16, 24, 'float'] as const) {
      const whole = new Uint8Array(encodeWavChannels([l, r], 48000, f))
      const pieces = new Uint8Array(streamed([[l.subarray(0, 300), r.subarray(0, 300)], [l.subarray(300), r.subarray(300)]], f, 2, 48000))
      expect(pieces).toEqual(whole)
    }
  })

  it('decodes back to the same samples (mono, 24-bit)', () => {
    const x = Float32Array.from({ length: 480 }, (_, i) => (i % 2 ? 0.25 : -0.5))
    const back = decodeWav(streamed([[x]], 24, 1, 44100))!
    expect(back.sampleRate).toBe(44100)
    expect(back.pcm[1]).toBeCloseTo(0.25, 5)
    expect(back.pcm[0]).toBeCloseTo(-0.5, 5)
  })

  it('names are safe, numbered and never collide', () => {
    expect(safeName('Micro: voz/guitarra?')).toBe('Micro vozguitarra')
    expect(safeName('   ...  ')).toBe('pista')
    expect(trackFileNames(['Micro 1', 'Micro 1', 'Bus A1'])).toEqual(['01 Micro 1.wav', '02 Micro 1.wav', '03 Bus A1.wav'])
    expect(sessionFolderName(new Date(2026, 9, 25, 15, 4, 9))).toBe('Multipista 2026-10-25 15-04-09')
  })

  it('timecode and data rate', () => {
    expect(fmtTimecode(3723.456)).toBe('01:02:03.456')
    // 2 mono + 1 stereo at 24-bit 48 kHz
    expect(bytesPerSecond([{ channels: 1 }, { channels: 1 }, { channels: 2 }], 24, 48000)).toBe(4 * 3 * 48000)
  })
})
