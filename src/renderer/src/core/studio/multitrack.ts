import type { WavFormat } from './analysis'

// Multitrack recording helpers (pure, shared by the renderer and the main process, which
// streams the files to disk): WAV header with patchable sizes, PCM packing, file names and
// the session description written next to the tracks.

export const WAV_HEADER_BYTES = 44

export function bytesPerSample(format: WavFormat): number {
  return format === 16 ? 2 : format === 24 ? 3 : 4
}

/** Canonical 44-byte WAV header; `frames` can be patched later with patchWavSizes */
export function wavHeader(format: WavFormat, channels: number, sampleRate: number, frames: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES)
  const v = new DataView(out.buffer)
  const bps = bytesPerSample(format)
  const block = bps * channels
  const data = frames * block
  const str = (o: number, s: string): void => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + data, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  // 3 = IEEE float, 1 = PCM
  v.setUint16(20, format === 'float' ? 3 : 1, true)
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * block, true)
  v.setUint16(32, block, true)
  v.setUint16(34, bps * 8, true)
  str(36, 'data')
  v.setUint32(40, data, true)
  return out
}

/** The two size fields of a header (RIFF size at 4, data size at 40) for a finished file */
export function wavSizes(dataBytes: number): { riff: Uint8Array; data: Uint8Array } {
  const riff = new Uint8Array(4)
  const data = new Uint8Array(4)
  // WAV sizes are 32-bit: beyond 4 GB the header saturates (readers then use the file size)
  new DataView(riff.buffer).setUint32(0, Math.min(0xffffffff, 36 + dataBytes), true)
  new DataView(data.buffer).setUint32(0, Math.min(0xffffffff, dataBytes), true)
  return { riff, data }
}

/** Interleaves channels into little-endian PCM (16/24-bit int or 32-bit float), like encodeWavChannels */
export function pcmBytes(channels: Float32Array[], format: WavFormat): Uint8Array {
  const nch = Math.max(1, channels.length)
  const frames = Math.min(...channels.map((c) => c.length))
  const bps = bytesPerSample(format)
  const out = new Uint8Array(frames * nch * bps)
  const v = new DataView(out.buffer)
  let o = 0
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][i]))
      if (format === 'float') {
        v.setFloat32(o, channels[c][i], true)
      } else if (format === 16) {
        // Truncates like encodeWavChannels, so both writers produce the same bytes
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
      } else {
        const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff)
        v.setUint8(o, s & 0xff)
        v.setUint8(o + 1, (s >> 8) & 0xff)
        v.setUint8(o + 2, (s >> 16) & 0xff)
      }
      o += bps
    }
  }
  return out
}

/** File-system safe name (Windows and macOS), never empty */
export function safeName(name: string, fallback = 'pista'): string {
  const s = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return s.slice(0, 60) || fallback
}

/** "03 Micro voz.wav"; duplicates get " (2)", " (3)"… */
export function trackFileNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((n, i) => {
    const base = `${String(i + 1).padStart(2, '0')} ${safeName(n)}`
    let name = `${base}.wav`
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} (${k}).wav`
    used.add(name.toLowerCase())
    return name
  })
}

/** Folder for one take: "Multipista 2026-10-25 15-04-09" */
export function sessionFolderName(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Multipista ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

export interface MultitrackTrack {
  name: string
  file: string
  channels: number
  /** What was recorded: strip at a tap point, or a bus */
  source: string
}

export interface MultitrackSession {
  app: 'gritometro-multipista'
  version: 1
  startedAt: string
  sampleRate: number
  format: WavFormat
  durationS: number
  tracks: MultitrackTrack[]
  markers: { timeS: number; label: string }[]
}

/** Seconds → "HH:MM:SS.mmm" (for the session text and the marker list) */
export function fmtTimecode(s: number): string {
  const ms = Math.round(s * 1000)
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(sec)}.${p(ms % 1000, 3)}`
}

/** Bytes per second of a set of tracks, for the disk-use readout */
export function bytesPerSecond(tracks: { channels: number }[], format: WavFormat, sampleRate: number): number {
  return tracks.reduce((n, t) => n + t.channels, 0) * bytesPerSample(format) * sampleRate
}
