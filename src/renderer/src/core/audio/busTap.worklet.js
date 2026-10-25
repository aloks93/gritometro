// Stereo PCM tap for mixer buses: posts [left, right] chunks of 4096 frames for recording.
class BusTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 4096
    this.reset()
    this.port.onmessage = (e) => {
      // 'flush' sends whatever is buffered (end of a recording)
      if (e.data === 'flush' && this.n > 0) {
        this.port.postMessage({ left: this.left.slice(0, this.n), right: this.right.slice(0, this.n) })
        this.reset()
      }
    }
  }

  reset() {
    this.left = new Float32Array(this.size)
    this.right = new Float32Array(this.size)
    this.n = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (input && input[0]) {
      const l = input[0]
      const r = input[1] || input[0]
      this.left.set(l, this.n)
      this.right.set(r, this.n)
      this.n += l.length
      if (this.n >= this.size) {
        this.port.postMessage({ left: this.left, right: this.right }, [this.left.buffer, this.right.buffer])
        this.reset()
      }
    }
    return true
  }
}

registerProcessor('bus-tap', BusTap)
