// Lossless FLAC encoder (16/24-bit, any channel count). Fixed linear predictors (orders 0–4)
// with partitioned Rice residuals, falling back to verbatim when prediction doesn't pay.
// Spec: https://xiph.org/flac/format.html. MD5 is left as zero ("unknown"), as allowed.

export type FlacBits = 16 | 24

const BLOCK = 4096
const MAX_PARTITION_ORDER = 6
const MAX_RICE = 14

class BitWriter {
  buf = new Uint8Array(1 << 16)
  pos = 0
  private acc = 0
  private nacc = 0

  private push(byte: number): void {
    if (this.pos === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.pos++] = byte
  }

  /** Writes the low `bits` bits of a non-negative `value` (bits ≤ 53) */
  write(value: number, bits: number): void {
    while (bits > 0) {
      const take = Math.min(bits, 8 - this.nacc)
      const shift = bits - take
      const div = 2 ** shift
      const chunk = Math.floor(value / div) & ((1 << take) - 1)
      value -= Math.floor(value / div) * div
      this.acc = (this.acc << take) | chunk
      this.nacc += take
      bits -= take
      if (this.nacc === 8) {
        this.push(this.acc)
        this.acc = 0
        this.nacc = 0
      }
    }
  }

  writeSigned(value: number, bits: number): void {
    this.write(value < 0 ? value + 2 ** bits : value, bits)
  }

  zeros(n: number): void {
    while (n > 0) {
      const take = Math.min(n, 8 - this.nacc)
      this.acc = (this.acc << take) & 0xff
      this.nacc += take
      n -= take
      if (this.nacc === 8) {
        this.push(this.acc)
        this.acc = 0
        this.nacc = 0
      }
    }
  }

  align(): void {
    if (this.nacc > 0) this.write(0, 8 - this.nacc)
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

const CRC8 = new Uint8Array(256)
const CRC16 = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
  CRC8[i] = c
  let d = i << 8
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff
  CRC16[i] = d
}

export function crc8(b: Uint8Array, from: number, to: number): number {
  let c = 0
  for (let i = from; i < to; i++) c = CRC8[c ^ b[i]]
  return c
}

export function crc16(b: Uint8Array, from: number, to: number): number {
  let c = 0
  for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]
  return c
}

/** FLAC's UTF-8-style coding of the frame number */
function writeUtf8(w: BitWriter, n: number): void {
  if (n < 0x80) return w.write(n, 8)
  const bytes = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6
  const lead = [0, 0, 0xc0, 0xe0, 0xf0, 0xf8, 0xfc][bytes]
  w.write(lead | Math.floor(n / 2 ** (6 * (bytes - 1))), 8)
  for (let i = bytes - 2; i >= 0; i--) w.write(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f), 8)
}

function residuals(x: Int32Array, order: number): Int32Array {
  const r = new Int32Array(x.length - order)
  for (let i = order; i < x.length; i++) {
    let p = 0
    if (order === 1) p = x[i - 1]
    else if (order === 2) p = 2 * x[i - 1] - x[i - 2]
    else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]
    else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4]
    r[i - order] = x[i] - p
  }
  return r
}

const zigzag = (v: number): number => (v >= 0 ? 2 * v : -2 * v - 1)

/** Exact bit cost of a Rice partition with parameter k */
function riceCost(u: Float64Array, from: number, to: number, k: number): number {
  let bits = (to - from) * (k + 1)
  const div = 2 ** k
  for (let i = from; i < to; i++) bits += Math.floor(u[i] / div)
  return bits
}

interface RicePlan {
  order: number
  params: number[]
  bits: number
}

/** Best partition order and per-partition Rice parameters for these residuals */
function planRice(u: Float64Array, blockSize: number, predOrder: number): RicePlan {
  let best: RicePlan | null = null
  for (let po = 0; po <= MAX_PARTITION_ORDER; po++) {
    const parts = 1 << po
    if (blockSize % parts !== 0 || blockSize / parts <= predOrder) break
    const per = blockSize / parts
    const params: number[] = []
    let bits = 6
    let start = 0
    for (let p = 0; p < parts; p++) {
      const end = start + per - (p === 0 ? predOrder : 0)
      let sum = 0
      for (let i = start; i < end; i++) sum += u[i]
      const mean = end > start ? sum / (end - start) : 0
      const guess = mean > 1 ? Math.min(MAX_RICE, Math.floor(Math.log2(mean))) : 0
      let bk = guess
      let bc = Infinity
      for (let k = Math.max(0, guess - 1); k <= Math.min(MAX_RICE, guess + 1); k++) {
        const c = riceCost(u, start, end, k)
        if (c < bc) {
          bc = c
          bk = k
        }
      }
      params.push(bk)
      bits += 4 + bc
      start = end
    }
    if (!best || bits < best.bits) best = { order: po, params, bits }
  }
  return best!
}

function writeSubframe(w: BitWriter, x: Int32Array, bps: number): void {
  const n = x.length
  let constant = true
  for (let i = 1; i < n && constant; i++) if (x[i] !== x[0]) constant = false
  if (constant) {
    w.write(0, 8)
    w.writeSigned(x[0], bps)
    return
  }
  // Pick the fixed predictor with the smallest residual magnitude, then plan its coding
  let bestOrder = 0
  let bestSum = Infinity
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const r = residuals(x, order)
    let s = 0
    for (let i = 0; i < r.length; i++) s += Math.abs(r[i])
    if (s < bestSum) {
      bestSum = s
      bestOrder = order
    }
  }
  const r = residuals(x, bestOrder)
  const u = new Float64Array(r.length)
  for (let i = 0; i < r.length; i++) u[i] = zigzag(r[i])
  const plan = planRice(u, n, bestOrder)
  const fixedBits = 8 + bestOrder * bps + 2 + plan.bits
  if (fixedBits >= 8 + n * bps) {
    w.write(0b00000010, 8)
    for (let i = 0; i < n; i++) w.writeSigned(x[i], bps)
    return
  }
  w.write(0b00010000 | (bestOrder << 1), 8)
  for (let i = 0; i < bestOrder; i++) w.writeSigned(x[i], bps)
  w.write(0, 2)
  w.write(plan.order, 4)
  const parts = 1 << plan.order
  const per = n / parts
  let start = 0
  for (let p = 0; p < parts; p++) {
    const end = start + per - (p === 0 ? bestOrder : 0)
    const k = plan.params[p]
    const div = 2 ** k
    w.write(k, 4)
    for (let i = start; i < end; i++) {
      const q = Math.floor(u[i] / div)
      w.zeros(q)
      w.write(1, 1)
      if (k > 0) w.write(u[i] - q * div, k)
    }
    start = end
  }
}

function quantize(pcm: Float32Array, bps: FlacBits): Int32Array {
  const max = bps === 16 ? 32767 : 8388607
  const min = -max - 1
  const out = new Int32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(min, Math.min(max, Math.round(pcm[i] * max)))
  return out
}

/** Encodes channels (same length) to a complete .flac file */
export function encodeFlac(channels: Float32Array[], sampleRate: number, bps: FlacBits = 24): Uint8Array {
  const nch = channels.length
  if (nch < 1 || nch > 8) throw new Error('FLAC admite de 1 a 8 canales.')
  const total = Math.min(...channels.map((c) => c.length))
  const ints = channels.map((c) => quantize(c.subarray(0, total), bps))
  const w = new BitWriter()
  w.write(0x664c6143, 32) // "fLaC"
  // STREAMINFO (last metadata block); frame sizes are patched in after encoding
  w.write(1, 1)
  w.write(0, 7)
  w.write(34, 24)
  const info = w.pos
  w.write(BLOCK, 16)
  w.write(BLOCK, 16)
  w.write(0, 24)
  w.write(0, 24)
  w.write(sampleRate, 20)
  w.write(nch - 1, 3)
  w.write(bps - 1, 5)
  w.write(Math.floor(total / 2 ** 32), 4)
  w.write(total % 2 ** 32, 32)
  for (let i = 0; i < 4; i++) w.write(0, 32)

  let minFrame = Infinity
  let maxFrame = 0
  for (let f = 0, start = 0; start < total; f++, start += BLOCK) {
    const n = Math.min(BLOCK, total - start)
    const frameStart = w.pos
    w.write(0b11111111111110, 14)
    w.write(0, 1)
    w.write(0, 1) // fixed block size
    w.write(0b0111, 4) // block size: 16-bit (n − 1) after the header
    w.write(0b0000, 4) // sample rate: from STREAMINFO
    w.write(nch - 1, 4) // independent channels
    w.write(bps === 16 ? 0b100 : 0b110, 3)
    w.write(0, 1)
    writeUtf8(w, f)
    w.write(n - 1, 16)
    w.write(crc8(w.buf, frameStart, w.pos), 8)
    for (const ch of ints) writeSubframe(w, ch.subarray(start, start + n), bps)
    w.align()
    w.write(crc16(w.buf, frameStart, w.pos), 16)
    const size = w.pos - frameStart
    minFrame = Math.min(minFrame, size)
    maxFrame = Math.max(maxFrame, size)
  }
  const out = w.bytes().slice()
  if (total > 0) {
    // min/max frame size (24 bits each) sit right after the two block sizes
    const put24 = (o: number, v: number): void => {
      out[o] = (v >> 16) & 0xff
      out[o + 1] = (v >> 8) & 0xff
      out[o + 2] = v & 0xff
    }
    put24(info + 4, minFrame)
    put24(info + 7, maxFrame)
  }
  return out
}
