import { describe, expect, it } from 'vitest'
import { EN, PATTERNS } from './i18n.en'
import { translateText } from './i18n'

describe('studio English', () => {
  it('translates exact texts and keeps the surrounding spaces React renders', () => {
    expect(translateText('Mezclador')).toBe('Mixer')
    expect(translateText('Pico ')).toBe('Peak ')
    expect(translateText('  Ruido de fondo')).toBe('  Noise floor')
  })

  it('fills templates and translates known words inside them', () => {
    expect(translateText('Saturó 3 veces en los últimos 3 s (pico 1.1 dBFS).')).toBe('Clipped 3 times in the last 3 s (peak 1.1 dBFS).')
    expect(translateText('Micro 1 suena por A1: usa auriculares o se acoplará con altavoces.')).toBe('Mic 1 plays through A1: use headphones or it will feed back through speakers.')
    expect(translateText('Por uso: Voz hablada → SM58; Canto → U87.')).toBe('By use: Speech → SM58; Singing → U87.')
    expect(translateText('Pico -20.5 dBFS → ganancia 8.5 dB')).toBe('Peak -20.5 dBFS → gain 8.5 dB')
    expect(translateText('Preset aplicado: Voz hablada · Micro USB')).toBe('Preset applied: Speech · USB mic')
    expect(translateText('Barro (300 Hz): -2.5 dB')).toBe('Mud (300 Hz): -2.5 dB')
  })

  it('splits " · " composites and translates each part', () => {
    expect(translateText('2 canales (hasta 8) · 48 kHz · admite 44.1–96 kHz · latencia 10.6 ms')).toBe('2 channels (up to 8) · 48 kHz · supports 44.1–96 kHz · latency 10.6 ms')
  })

  it('leaves numbers, units and unknown text alone', () => {
    expect(translateText('-12.3 dB')).toBe('-12.3 dB')
    expect(translateText('SM58 a 10 cm')).toBe('SM58 a 10 cm')
    expect(translateText('La4')).toBe('A4')
    expect(translateText('Sol#3')).toBe('G#3')
  })

  it('every pattern has the same placeholders in both languages', () => {
    for (const [es, en] of PATTERNS) {
      const ph = (s: string): string => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')
      expect(ph(en), es).toBe(ph(es))
    }
    expect(Object.values(EN).every((v) => v.trim().length > 0)).toBe(true)
  })
})
