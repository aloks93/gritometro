import { useEffect, useState } from 'react'
import { audioEngine, type EngineState } from '../core/audio/AudioEngine'
import { effectiveProfile } from '../core/audio/AudioConfig'
import type { LevelReading } from '../core/audio/LevelAnalyzer'
import { normalizeLevel } from '../core/audio/LevelAnalyzer'
import { useStore } from './store'

export function useEngineState(): EngineState {
  const [state, setState] = useState(audioEngine.state)
  useEffect(() => audioEngine.onState(setState), [])
  return state
}

export function useReading(): LevelReading | null {
  const [reading, setReading] = useState<LevelReading | null>(audioEngine.last)
  useEffect(() => audioEngine.onReading(setReading), [])
  return reading
}

/** Live 0..1 level relative to the active profile's noise floor */
export function useLevel(): { level: number; reading: LevelReading | null } {
  const { data } = useStore()
  const reading = useReading()
  const profile = effectiveProfile(data.audio)
  const level = reading ? normalizeLevel(reading.smoothedDb, profile.noiseFloorDb, data.settings.rangeDb) : 0
  return { level, reading }
}

export function useKey(key: string, handler: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      if (e.code === key) {
        e.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, handler, enabled])
}
