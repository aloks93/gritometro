import { describe, expect, it } from 'vitest'
import type { TakeMetrics } from './analysis'
import {
  buildSession,
  buildSessionReportHtml,
  clipMarkers,
  markersCsv,
  parseMeasurementSession,
  serializeMeasurementSession,
  sessionConclusions,
  timecode,
  withClipMarkers,
  type Marker
} from './session'
import { mergeStudio } from './studio'

const SR = 48000

describe('timecode', () => {
  it('formats HH:MM:SS:FF at 25 fps', () => {
    expect(timecode(0)).toBe('00:00:00:00')
    expect(timecode(1.5)).toBe('00:00:01:12')
    expect(timecode(3725.04)).toBe('01:02:05:01')
    expect(timecode(10, 30)).toBe('00:00:10:00')
    expect(timecode(-3)).toBe('00:00:00:00')
  })
})

describe('clip markers', () => {
  it('one marker per clipping event, nearby clips merged', () => {
    const pcm = new Float32Array(SR * 3)
    pcm[SR * 0.5] = 1
    pcm[SR * 0.5 + 100] = -1
    pcm[SR * 2] = 1
    const m = clipMarkers(pcm, SR)
    expect(m).toHaveLength(2)
    expect(m[0]).toMatchObject({ t: 0.5, kind: 'clip', label: 'Saturación (2 muestras)' })
    expect(m[1].t).toBe(2)
    expect(clipMarkers(new Float32Array(100), SR)).toEqual([])
  })

  it('refreshing clip markers keeps user ones and sorts by time', () => {
    const user: Marker[] = [{ t: 1, label: 'Entra la voz', kind: 'user' }]
    const old: Marker[] = [{ t: 0.2, label: 'vieja', kind: 'clip' }]
    const out = withClipMarkers([...user, ...old], [{ t: 0.5, label: 'nueva', kind: 'clip' }])
    expect(out.map((x) => x.label)).toEqual(['nueva', 'Entra la voz'])
  })

  it('exports a semicolon CSV with timecode and escaped labels', () => {
    const csv = markersCsv([{ name: 'Toma 1', markers: [{ t: 1.5, label: 'dice "hola"', kind: 'user' }] }])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toContain('"Toma 1";"00:00:01:12";"1,500";"Marcador";"dice ""hola"""')
  })
})

const metrics = (over: Partial<TakeMetrics>): TakeMetrics => ({
  noiseFloorDb: -70,
  levelDb: -20,
  peakDb: -6,
  snrDb: 50,
  crestDb: 14,
  clipCount: 0,
  centroidHz: 2000,
  bands: { low: 0.2, mid: 0.6, high: 0.2 },
  curve: [],
  durationS: 8,
  ...over
})

const session = (): ReturnType<typeof buildSession> =>
  buildSession(
    {
      meta: { title: 'Prueba <sala>', operator: 'Ana', location: 'Estudio', notes: 'Micros a 20 cm' },
      profile: { name: 'Interfaz', deviceLabel: 'USB', mode: 'advanced', gainDb: 0, splOffset: 120, noiseFloorDb: -68 },
      calibration: { id: 'c', atIso: '2026-10-20T10:00:00Z', method: 'calibrator', offsetDb: 120, refDb: 94 },
      takes: [
        { name: 'Toma A', durationS: 12, sampleRate: 48000, lufs: -18, truePeakDb: -3, peakDb: -3.5, rmsDb: -22, clippedSamples: 0, markers: [] },
        { name: 'Toma B', durationS: 5, sampleRate: 48000, lufs: -10, truePeakDb: 0.2, peakDb: 0, rmsDb: -12, clippedSamples: 40, markers: [{ t: 2, label: 'Saturación (40 muestras)', kind: 'clip' }] }
      ],
      candidates: [
        { id: 'a', name: 'SM58', deviceId: null, channel: 'mix', gainDb: 0, metrics: metrics({ snrDb: 50 }) },
        { id: 'b', name: 'Barato', deviceId: null, channel: 'mix', gainDb: 0, metrics: metrics({ snrDb: 22, noiseFloorDb: -45 }), rating: 5 }
      ]
    },
    new Date('2026-10-25T12:00:00Z')
  )

describe('measurement session', () => {
  it('concludes the best mic, the blind favourite, the noisiest mic and the clipped take', () => {
    const c = sessionConclusions(session()).join(' | ')
    expect(c).toMatch(/recomendado: SM58/)
    expect(c).toMatch(/a ciegas se prefirió Barato/)
    expect(c).toMatch(/Peor ruido de fondo: Barato/)
    expect(c).toMatch(/saturación: Toma B/)
    expect(c).toMatch(/Calibrado/)
  })

  it('round-trips through JSON and rejects foreign files', () => {
    const s = session()
    const back = parseMeasurementSession(serializeMeasurementSession(s))
    expect(back).toEqual(s)
    expect(() => parseMeasurementSession('{"app":"otra"}')).toThrow(/No es una sesión/)
    expect(() => parseMeasurementSession('nope')).toThrow(/JSON/)
  })

  it('the report escapes user text and lists takes and markers', () => {
    const html = buildSessionReportHtml(session())
    expect(html).toContain('Prueba &lt;sala&gt;')
    expect(html).toContain('Toma B')
    expect(html).toContain('00:00:02:00')
    expect(html).not.toContain('<sala>')
  })

  it('old studio saves get empty session metadata', () => {
    expect(mergeStudio({}).sessionMeta).toEqual({ title: '', operator: '', location: '', notes: '' })
  })
})
