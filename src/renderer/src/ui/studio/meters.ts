import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { audioEngine } from '../../core/audio/AudioEngine'
import { LoudnessMeter, SoundLevelMeter, type LoudnessReading, type SlmReading } from '../../core/studio/loudness'
import { detectPitch, type PitchResult } from '../../core/studio/pitch'
import { useInterval } from './widgets'

/** Feeds a streaming meter from the engine's PCM tap; recreated when the sample rate changes */
function usePcmMeter<M extends { push: (s: Float32Array) => void; readonly sampleRate: number }>(
  create: (sampleRate: number) => M,
  enabled: boolean
): MutableRefObject<M | null> {
  const meter = useRef<M | null>(null)
  const factory = useRef(create)
  factory.current = create
  useEffect(() => {
    if (!enabled) return
    return audioEngine.onPcm((chunk, _frame, sampleRate) => {
      if (!meter.current || meter.current.sampleRate !== sampleRate) meter.current = factory.current(sampleRate)
      meter.current.push(chunk)
    })
  }, [enabled])
  return meter
}

export function useLoudness(enabled = true): { reading: LoudnessReading | null; reset: () => void } {
  const meter = usePcmMeter((sr) => new LoudnessMeter(sr), enabled)
  const [reading, setReading] = useState<LoudnessReading | null>(null)
  useInterval(() => setReading(meter.current?.reading() ?? null), 100, enabled)
  const reset = useCallback(() => {
    meter.current?.reset()
    setReading(meter.current?.reading() ?? null)
  }, [meter])
  return { reading, reset }
}

export interface SlmSample {
  t: number
  fast: number
  slow: number
}

/** Sound level meter plus a rolling history of the selected weighting (for the graph) */
export function useSoundLevel(offsetDb: number, weighting: 'A' | 'C' | 'Z', historySeconds = 120): {
  reading: SlmReading | null
  history: SlmSample[]
  reset: () => void
} {
  const meter = usePcmMeter((sr) => new SoundLevelMeter(sr, offsetDb), true)
  const [reading, setReading] = useState<SlmReading | null>(null)
  const history = useRef<SlmSample[]>([])
  useEffect(() => {
    if (meter.current) meter.current.offsetDb = offsetDb
  }, [offsetDb, meter])
  useInterval(() => {
    const m = meter.current
    if (!m) return
    m.offsetDb = offsetDb
    const r = m.reading()
    const now = performance.now()
    // The exponential averages start from silence: skip the first half second
    if (r.durationS > 0.5) history.current.push({ t: now, fast: r.fast[weighting], slow: r.slow[weighting] })
    const cutoff = now - historySeconds * 1000
    while (history.current.length && history.current[0].t < cutoff) history.current.shift()
    setReading(r)
  }, 100)
  const reset = useCallback(() => {
    meter.current?.reset()
    history.current = []
  }, [meter])
  return { reading, history: history.current, reset }
}

/** Live pitch of the analyser frame, a few times per second */
export function usePitch(enabled = true): PitchResult | null {
  const [pitch, setPitch] = useState<PitchResult | null>(null)
  useInterval(
    () => {
      const w = audioEngine.waveform()
      setPitch(w ? detectPitch(w, audioEngine.sampleRate) : null)
    },
    100,
    enabled
  )
  return pitch
}
