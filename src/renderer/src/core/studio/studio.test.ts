import { describe, expect, it } from 'vitest'
import { buildReportHtml, escapeHtml } from './report'
import { defaultStudio, mergeCandidates, mergeStudio, parseSession, serializeSession, type MicCandidate } from './studio'

const metrics = {
  noiseFloorDb: -70,
  levelDb: -24,
  peakDb: -8,
  snrDb: 46,
  crestDb: 16,
  clipCount: 0,
  centroidHz: 1800,
  bands: { low: 0.2, mid: 0.7, high: 0.1 },
  curve: Array(26).fill(0),
  durationS: 8
}

const mic = (id: string, name: string, extra: Partial<MicCandidate> = {}): MicCandidate => ({ id, name, deviceId: null, channel: 'mix', gainDb: 0, ...extra })

describe('studio data', () => {
  it('merges nested prefs from older saves', () => {
    const s = mergeStudio({ takeSeconds: 5, prefs: { tunerA4: 442 } as never })
    expect(s.takeSeconds).toBe(5)
    expect(s.prefs.tunerA4).toBe(442)
    expect(s.prefs.spectrumMode).toBe('fft')
    expect(s.wavFormat).toBe(24)
    expect(mergeStudio(null)).toEqual(defaultStudio())
  })

  it('round-trips a session file', () => {
    const studio = { ...defaultStudio(), candidates: [mic('a', 'SM58', { metrics, rating: 4 })] }
    const back = parseSession(serializeSession(studio))
    expect(back.candidates).toHaveLength(1)
    expect(back.candidates[0].metrics?.snrDb).toBe(46)
    expect(back.candidates[0].rating).toBe(4)
  })

  it('rejects foreign or broken files', () => {
    expect(() => parseSession('{')).toThrow(/JSON/)
    expect(() => parseSession('{"app":"otra"}')).toThrow(/sesión/)
    const s = parseSession(JSON.stringify({ app: 'gritometro-studio', candidates: [{ id: 1 }, { id: 'x', name: 'ok', channel: 'raro' }] }))
    expect(s.candidates).toHaveLength(1)
    expect(s.candidates[0].channel).toBe('mix')
  })

  it('renames clashing ids on import', () => {
    let n = 0
    const merged = mergeCandidates([mic('a', 'A')], [mic('a', 'B'), mic('c', 'C')], () => `new${++n}`)
    expect(merged.map((c) => c.id)).toEqual(['a', 'new1', 'c'])
  })
})

describe('report', () => {
  it('escapes names and ranks by technical score', () => {
    const html = buildReportHtml([mic('a', 'Malo <script>', { metrics: { ...metrics, snrDb: 10 } }), mic('b', 'Bueno', { metrics })])
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html.indexOf('Bueno')).toBeLessThan(html.indexOf('Malo'))
    expect(html).toContain('<polyline')
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;')
  })
})

describe('studio access code', () => {
  // The real code never goes in the (public) repo: set STUDIO_CODE to check it locally
  it('rejects wrong or malformed codes', async () => {
    const { isValidStudioCode, sha256Hex } = await import('./unlock')
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await isValidStudioCode('0000000')).toBe(false)
    expect(await isValidStudioCode('')).toBe(false)
    expect(await isValidStudioCode('abc')).toBe(false)
  })

  it.skipIf(!process.env.STUDIO_CODE)('accepts the configured code', async () => {
    const { isValidStudioCode } = await import('./unlock')
    const code = process.env.STUDIO_CODE!
    expect(await isValidStudioCode(code)).toBe(true)
    expect(await isValidStudioCode(` ${code.slice(0, 3)}-${code.slice(3)} `)).toBe(true)
  })
})
