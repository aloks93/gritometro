// Multitrack tap: records 1 or 2 channels from `startFrame` until the frame given by a 'stop'
// message, so every track of a take starts and ends on exactly the same sample. Posts chunks of
// 8192 frames ({ channels: Float32Array[] }) and a final { channels, done: true }.
class TrackTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const p = options.processorOptions || {}
    this.nch = p.channels || 1
    this.startFrame = p.startFrame || 0
    this.stopFrame = Infinity
    this.size = 8192
    this.done = false
    this.alloc()
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stop') this.stopFrame = e.data.frame
    }
  }

  alloc() {
    this.buf = Array.from({ length: this.nch }, () => new Float32Array(this.size))
    this.n = 0
  }

  flush(done) {
    const channels = this.buf.map((b) => b.slice(0, this.n))
    this.port.postMessage({ channels, done }, channels.map((c) => c.buffer))
    this.alloc()
  }

  process(inputs) {
    if (this.done) return false
    const input = inputs[0] || []
    const len = 128
    const f0 = currentFrame
    const from = Math.max(0, this.startFrame - f0)
    const to = Math.min(len, this.stopFrame - f0)
    for (let i = from; i < to; i++) {
      for (let c = 0; c < this.nch; c++) {
        const src = input[c] || input[0]
        this.buf[c][this.n] = src ? src[i] : 0
      }
      if (++this.n === this.size) this.flush(false)
    }
    if (f0 + len >= this.stopFrame) {
      this.flush(true)
      this.done = true
      return false
    }
    return true
  }
}

registerProcessor('track-tap', TrackTap)
