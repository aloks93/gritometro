// Noise gate for a mixer strip (stereo-linked). Opens when the peak envelope crosses the
// threshold, stays open for `hold`, then fades to `range` dB. Posts its state ~20×/s.
class StripGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: -60, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 2, minValue: 0.1, maxValue: 200, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 80, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 150, minValue: 1, maxValue: 5000, automationRate: 'k-rate' }
    ]
  }

  constructor() {
    super()
    this.env = 0
    this.gain = 1
    this.holdLeft = 0
    this.open = true
    this.sinceReport = 0
  }

  process(inputs, outputs, params) {
    const input = inputs[0]
    const output = outputs[0]
    const enabled = params.enabled[0] >= 0.5
    const n = output[0] ? output[0].length : 128
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0)
      return true
    }
    if (!enabled) {
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)])
      this.gain = 1
      this.open = true
    } else {
      const thr = Math.pow(10, params.threshold[0] / 20)
      const floor = Math.pow(10, params.range[0] / 20)
      const att = 1 - Math.exp(-1 / ((params.attack[0] / 1000) * sampleRate))
      const rel = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate))
      const holdSamples = (params.hold[0] / 1000) * sampleRate
      // Envelope follower: instant attack, ~10 ms decay
      const envDecay = Math.exp(-1 / (0.01 * sampleRate))
      for (let i = 0; i < n; i++) {
        let peak = 0
        for (let c = 0; c < input.length; c++) {
          const a = Math.abs(input[c][i])
          if (a > peak) peak = a
        }
        this.env = peak > this.env ? peak : this.env * envDecay
        if (this.env >= thr) {
          this.open = true
          this.holdLeft = holdSamples
        } else if (this.holdLeft > 0) {
          this.holdLeft--
        } else {
          this.open = false
        }
        const target = this.open ? 1 : floor
        this.gain += (target - this.gain) * (target > this.gain ? att : rel)
        for (let c = 0; c < output.length; c++) output[c][i] = input[Math.min(c, input.length - 1)][i] * this.gain
      }
    }
    this.sinceReport += n
    if (this.sinceReport >= sampleRate / 20) {
      this.sinceReport = 0
      this.port.postMessage({ open: this.open, gainDb: this.gain > 0 ? 20 * Math.log10(this.gain) : -100 })
    }
    return true
  }
}

registerProcessor('strip-gate', StripGate)
