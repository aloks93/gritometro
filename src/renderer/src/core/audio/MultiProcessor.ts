import type { ProcessorConfig } from '../processor/processor'
import { channelConfig, liveChannels } from '../processor/channels'
import { processorEngine, ProcessorEngine, type ProcessorLevels, type ProcessorState } from './ProcessorEngine'

// Parallel processing: every channel marked "live" (except the one loaded in the processor,
// which the main engine runs) gets its own processor engine with its saved setup, to its own
// output. They follow the processor's power button: on together, off together.

export interface ParallelChannel {
  key: string
  state: ProcessorState
  levels: ProcessorLevels | null
}

class MultiProcessor {
  private engines = new Map<string, ProcessorEngine>()
  private offs = new Map<string, () => void>()
  private cfg: ProcessorConfig | null = null
  private active = false
  private listeners = new Set<() => void>()

  constructor() {
    processorEngine.onState((s) => {
      const active = s.status !== 'off'
      if (active === this.active) return
      this.active = active
      this.sync()
    })
  }

  /** Follows every processor edit: starts, updates or stops the parallel channels */
  apply(cfg: ProcessorConfig): void {
    this.cfg = cfg
    this.sync()
  }

  stopAll(): void {
    this.active = false
    this.sync()
  }

  /** Keys of the channels running in parallel (starting, on or failed) */
  keys(): string[] {
    return [...this.engines.keys()]
  }

  channel(key: string): ParallelChannel | null {
    const e = this.engines.get(key)
    return e ? { key, state: e.state, levels: e.levels() } : null
  }

  /** Called when a channel starts/stops or changes state */
  onChange(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private sync(): void {
    const cfg = this.cfg
    const want = this.active && cfg ? liveChannels(cfg) : []
    let changed = false
    for (const [key, e] of this.engines) {
      if (want.includes(key)) continue
      e.stop()
      this.offs.get(key)?.()
      this.offs.delete(key)
      this.engines.delete(key)
      changed = true
    }
    if (!cfg) return
    for (const key of want) {
      const c = channelConfig(cfg, key)
      const e = this.engines.get(key)
      if (e) {
        e.apply(c)
        continue
      }
      const engine = new ProcessorEngine()
      this.engines.set(key, engine)
      this.offs.set(key, engine.onState(() => this.emit()))
      void engine.start(c)
      changed = true
    }
    if (changed) this.emit()
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }
}

export const multiProcessor = new MultiProcessor()
