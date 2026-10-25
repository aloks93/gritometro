// Collects post-gain mono PCM in 2048-frame chunks and posts them to the main thread,
// tagged with the context frame of their first sample (used for latency measurements).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 2048
    this.buf = new Float32Array(this.size)
    this.n = 0
    this.startFrame = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      if (this.n === 0) this.startFrame = currentFrame
      this.buf.set(ch, this.n)
      this.n += ch.length
      if (this.n >= this.size) {
        this.port.postMessage({ frame: this.startFrame, data: this.buf }, [this.buf.buffer])
        this.buf = new Float32Array(this.size)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
