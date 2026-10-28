package com.gritometro.procesador.audio

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Streams interleaved float samples to a 24-bit PCM WAV; the header sizes are patched on close */
class WavWriter(val file: File, val sampleRate: Int, val channels: Int) {
    private val out = BufferedOutputStream(FileOutputStream(file), 1 shl 16)
    private var bytes = 0L
    private var bb = ByteBuffer.allocate(0).order(ByteOrder.LITTLE_ENDIAN)

    init {
        out.write(header(0))
    }

    val frames: Long get() = bytes / (3 * channels)

    fun write(data: FloatArray, count: Int = data.size) {
        if (bb.capacity() < count * 3) bb = ByteBuffer.allocate(count * 3).order(ByteOrder.LITTLE_ENDIAN)
        bb.clear()
        for (i in 0 until count) {
            val v = (data[i].coerceIn(-1f, 1f) * 8388607f).toInt()
            bb.put((v and 0xff).toByte())
            bb.put((v shr 8 and 0xff).toByte())
            bb.put((v shr 16 and 0xff).toByte())
        }
        out.write(bb.array(), 0, count * 3)
        bytes += count * 3
    }

    fun close() {
        out.flush()
        out.close()
        RandomAccessFile(file, "rw").use { it.seek(0); it.write(header(bytes)) }
    }

    private fun header(dataBytes: Long): ByteArray {
        val b = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt((36 + dataBytes).toInt())
        b.put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(channels.toShort())
        b.putInt(sampleRate).putInt(sampleRate * channels * 3).putShort((channels * 3).toShort()).putShort(24)
        b.put("data".toByteArray()).putInt(dataBytes.toInt())
        return b.array()
    }
}
