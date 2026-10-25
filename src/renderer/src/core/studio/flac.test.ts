import { describe, expect, it } from 'vitest'
import { rng } from './dsp'
import { crc16, crc8, encodeFlac } from './flac'

/** Minimal decoder for what the encoder emits (fixed/verbatim/constant subframes), to prove round-trips */
function decodeFlac(b: Uint8Array): { sampleRate: number; channels: number; bps: number; total: number; samples: Int32Array[]; frames: number } {
  let pos = 0
  let bit = 0
  const read = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) {
      v = v * 2 + ((b[pos] >> (7 - bit)) & 1)
      if (++bit === 8) {
        bit = 0
        pos++
      }
    }
    return v
  }
  const signed = (n: number): number => {
    const v = read(n)
    return v >= 2 ** (n - 1) ? v - 2 ** n : v
  }
  const align = (): void => {
    if (bit) {
      bit = 0
      pos++
    }
  }
  expect(String.fromCharCode(...b.subarray(0, 4))).toBe('fLaC')
  pos = 4
  const last = read(1)
  expect(last).toBe(1)
  expect(read(7)).toBe(0)
  expect(read(24)).toBe(34)
  read(16)
  read(16)
  const minFrame = read(24)
  const maxFrame = read(24)
  const sampleRate = read(20)
  const channels = read(3) + 1
  const bps = read(5) + 1
  const total = read(4) * 2 ** 32 + read(32)
  pos += 16
  const samples = Array.from({ length: channels }, () => new Int32Array(total))
  let done = 0
  let frames = 0
  while (done < total) {
    const start = pos
    expect(read(14)).toBe(0b11111111111110)
    read(2)
    expect(read(4)).toBe(0b0111)
    read(4)
    expect(read(4)).toBe(channels - 1)
    read(3)
    read(1)
    // UTF-8 frame number
    const lead = read(8)
    const extra = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3
    for (let i = 0; i < extra; i++) read(8)
    const n = read(16) + 1
    const hdrCrc = crc8(b, start, pos)
    expect(read(8)).toBe(hdrCrc)
    for (let c = 0; c < channels; c++) {
      const x = samples[c].subarray(done, done + n)
      read(1)
      const type = read(6)
      read(1)
      if (type === 0) {
        const v = signed(bps)
        x.fill(v)
      } else if (type === 1) {
        for (let i = 0; i < n; i++) x[i] = signed(bps)
      } else {
        const order = type & 7
        for (let i = 0; i < order; i++) x[i] = signed(bps)
        expect(read(2)).toBe(0)
        const po = read(4)
        const parts = 1 << po
        let i = order
        for (let p = 0; p < parts; p++) {
          const k = read(4)
          const count = n / parts - (p === 0 ? order : 0)
          for (let j = 0; j < count; j++, i++) {
            let q = 0
            while (read(1) === 0) q++
            const u = q * 2 ** k + (k ? read(k) : 0)
            const r = u % 2 === 0 ? u / 2 : -(u + 1) / 2
            const p1 = x[i - 1]
            const pred = order === 0 ? 0 : order === 1 ? p1 : order === 2 ? 2 * p1 - x[i - 2] : order === 3 ? 3 * p1 - 3 * x[i - 2] + x[i - 3] : 4 * p1 - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]
            x[i] = pred + r
          }
        }
      }
    }
    align()
    const crc = crc16(b, start, pos)
    expect(read(16)).toBe(crc)
    const size = pos - start
    expect(size).toBeGreaterThanOrEqual(minFrame)
    expect(size).toBeLessThanOrEqual(maxFrame)
    done += n
    frames++
  }
  expect(pos).toBe(b.length)
  return { sampleRate, channels, bps, total, samples, frames }
}

const SR = 48000
const quant = (pcm: Float32Array, bps: 16 | 24): number[] => {
  const max = bps === 16 ? 32767 : 8388607
  // `| 0` turns Math.round's −0 into the 0 an integer decoder returns
  return Array.from(pcm, (v) => Math.max(-max - 1, Math.min(max, Math.round(v * max))) | 0)
}

describe('FLAC encoder', () => {
  it('round-trips a sine exactly at 16 and 24 bits and compresses it', () => {
    const pcm = Float32Array.from({ length: 10000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR))
    for (const bps of [16, 24] as const) {
      const flac = encodeFlac([pcm], SR, bps)
      const d = decodeFlac(flac)
      expect(d).toMatchObject({ sampleRate: SR, channels: 1, bps, total: 10000, frames: 3 })
      expect(Array.from(d.samples[0])).toEqual(quant(pcm, bps))
      expect(flac.length).toBeLessThan((pcm.length * bps) / 8 / 1.5)
    }
  })

  it('round-trips stereo noise (verbatim fallback), silence and clipped input', () => {
    const r = rng(4)
    const noise = Float32Array.from({ length: 5000 }, () => r() * 2 - 1)
    const silence = new Float32Array(5000)
    const loud = Float32Array.from({ length: 5000 }, (_, i) => (i % 50 < 25 ? 1.5 : -1.5))
    const d = decodeFlac(encodeFlac([noise, silence], SR, 16))
    expect(d.channels).toBe(2)
    expect(Array.from(d.samples[0])).toEqual(quant(noise, 16))
    expect(Array.from(d.samples[1]).every((v) => v === 0)).toBe(true)
    const c = decodeFlac(encodeFlac([loud], 44100, 24))
    expect(c.sampleRate).toBe(44100)
    expect(Math.max(...c.samples[0])).toBe(8388607)
    expect(Math.min(...c.samples[0])).toBe(-8388608)
  })

  it('handles odd lengths, a tiny file and many frames', () => {
    const r = rng(8)
    let y = 0
    // Brown-ish noise: predictable enough for high orders and many partitions
    const pcm = Float32Array.from({ length: 4096 * 40 + 77 }, () => (y = Math.max(-0.9, Math.min(0.9, y + (r() - 0.5) * 0.02))))
    const d = decodeFlac(encodeFlac([pcm], SR, 24))
    expect(d.frames).toBe(41)
    expect(Array.from(d.samples[0])).toEqual(quant(pcm, 24))
    expect(decodeFlac(encodeFlac([new Float32Array([0.1, -0.2, 0.3])], SR, 16)).total).toBe(3)
    expect(() => encodeFlac([], SR)).toThrow()
  })
})
