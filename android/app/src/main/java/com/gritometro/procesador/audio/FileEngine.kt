package com.gritometro.procesador.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.os.Process
import android.provider.OpenableColumns
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** An audio file decoded to raw interleaved float (little-endian), at its own rate, 1 or 2 channels */
data class Decoded(val file: File, val name: String, val sampleRate: Int, val channels: Int, val frames: Long) {
    val seconds: Double get() = frames.toDouble() / sampleRate
}

class CancelledException : Exception()

/** Reads interleaved floats from a raw file, from any frame */
class FloatReader(private val d: Decoded) : AutoCloseable {
    private val raf = RandomAccessFile(d.file, "r")
    private val ch = raf.channel
    private var bb = ByteBuffer.allocateDirect(1 shl 16).order(ByteOrder.LITTLE_ENDIAN)

    fun seek(frame: Long) {
        ch.position(frame.coerceIn(0, d.frames) * 4 * d.channels)
    }

    /** Fills up to `frames` frames; returns the frames read (0 at the end) */
    fun read(out: FloatArray, frames: Int): Int {
        val bytes = frames * 4 * d.channels
        if (bb.capacity() < bytes) bb = ByteBuffer.allocateDirect(bytes).order(ByteOrder.LITTLE_ENDIAN)
        bb.clear()
        bb.limit(bytes)
        while (bb.hasRemaining()) if (ch.read(bb) <= 0) break
        bb.flip()
        val n = bb.remaining() / 4
        bb.asFloatBuffer().get(out, 0, n)
        return n / d.channels
    }

    override fun close() = raf.close()
}

private class FloatWriter(file: File) : AutoCloseable {
    private val out = BufferedOutputStream(FileOutputStream(file), 1 shl 16)
    private var bb = ByteBuffer.allocate(0).order(ByteOrder.LITTLE_ENDIAN)

    fun write(data: FloatArray, count: Int) {
        if (bb.capacity() < count * 4) bb = ByteBuffer.allocate(count * 4).order(ByteOrder.LITTLE_ENDIAN)
        bb.clear()
        for (i in 0 until count) bb.putFloat(data[i])
        out.write(bb.array(), 0, count * 4)
    }

    override fun close() = out.close()
}

object FileEngine {
    fun displayName(context: Context, uri: Uri): String {
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0)
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "audio"
    }

    /** Decodes the first audio track of any file Android can read (mp3, m4a, ogg/opus, wav, flac, video…) */
    fun decode(context: Context, uri: Uri, out: File, progress: (Float) -> Unit, cancelled: () -> Boolean): Decoded {
        val ex = MediaExtractor()
        ex.setDataSource(context, uri, null)
        val track = (0 until ex.trackCount).firstOrNull { ex.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
            ?: run { ex.release(); throw IllegalArgumentException("El archivo no tiene audio.") }
        ex.selectTrack(track)
        val fmt = ex.getTrackFormat(track)
        val mime = fmt.getString(MediaFormat.KEY_MIME)!!
        val durationUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) else 0L
        var sr = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        var srcCh = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        var floatPcm = false
        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(fmt, null, null, 0)
        codec.start()
        val writer = FloatWriter(out)
        val info = MediaCodec.BufferInfo()
        var inDone = false
        var outDone = false
        var frames = 0L
        var outCh = srcCh.coerceIn(1, 2)
        var tmp = FloatArray(0)
        try {
            while (!outDone) {
                if (cancelled()) throw CancelledException()
                if (!inDone) {
                    val i = codec.dequeueInputBuffer(10_000)
                    if (i >= 0) {
                        val buf = codec.getInputBuffer(i)!!
                        val n = ex.readSampleData(buf, 0)
                        if (n < 0) {
                            codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inDone = true
                        } else {
                            codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0)
                            ex.advance()
                        }
                    }
                }
                val o = codec.dequeueOutputBuffer(info, 10_000)
                if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val f = codec.outputFormat
                    sr = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    srcCh = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    outCh = srcCh.coerceIn(1, 2)
                    floatPcm = f.containsKey(MediaFormat.KEY_PCM_ENCODING) && f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
                } else if (o >= 0) {
                    val buf = codec.getOutputBuffer(o)!!.order(ByteOrder.LITTLE_ENDIAN)
                    buf.position(info.offset)
                    buf.limit(info.offset + info.size)
                    val samples = if (floatPcm) info.size / 4 else info.size / 2
                    val n = samples / srcCh
                    if (tmp.size < n * outCh) tmp = FloatArray(n * outCh)
                    if (floatPcm) {
                        val fb = buf.asFloatBuffer()
                        for (k in 0 until n) for (c in 0 until outCh) tmp[k * outCh + c] = fb.get(k * srcCh + c)
                    } else {
                        val sb = buf.asShortBuffer()
                        for (k in 0 until n) for (c in 0 until outCh) tmp[k * outCh + c] = sb.get(k * srcCh + c) / 32768f
                    }
                    writer.write(tmp, n * outCh)
                    frames += n
                    codec.releaseOutputBuffer(o, false)
                    if (durationUs > 0) progress((frames * 1_000_000.0 / sr / durationUs).toFloat().coerceIn(0f, 1f))
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
                }
            }
        } finally {
            writer.close()
            runCatching { codec.stop() }
            codec.release()
            ex.release()
        }
        if (frames == 0L) throw IllegalArgumentException("No se pudo leer el audio del archivo.")
        return Decoded(out, displayName(context, uri), sr, outCh, frames)
    }

    data class ExportResult(val file: File, val lufs: Float, val truePeak: Float, val gainDb: Float)

    /**
     * Processes the whole file (faster than real time), aligned (the chain's latency is removed),
     * optionally normalized to `targetLufs` without passing the limiter's ceiling, to WAV or M4A.
     */
    fun export(
        d: Decoded, settings: ProcessorSettings, dest: File, m4a: Boolean, targetLufs: Float?, ceilingDb: Float,
        progress: (Float) -> Unit, cancelled: () -> Boolean,
    ): ExportResult {
        val h = Native.create(d.sampleRate, d.channels)
        val processed = File(dest.parentFile, dest.name + ".tmp")
        try {
            Native.setChain(h, settings.chainJson, settings.inputGainDb, settings.outputGainDb, false)
            val lat = Native.latency(h)
            val block = 4096
            val buf = FloatArray(block * d.channels)
            FloatReader(d).use { r ->
                FloatWriter(processed).use { w ->
                    var skip = lat.toLong()
                    var done = 0L
                    var tail = lat.toLong()
                    while (true) {
                        if (cancelled()) throw CancelledException()
                        var n = r.read(buf, block)
                        if (n == 0) {
                            // Flush the latency with silence so the end isn't cut
                            if (tail <= 0) break
                            n = minOf(block.toLong(), tail).toInt()
                            buf.fill(0f, 0, n * d.channels)
                            tail -= n
                        }
                        Native.process(h, buf, n)
                        val from = minOf(skip, n.toLong()).toInt()
                        skip -= from
                        if (n > from) {
                            if (from == 0) w.write(buf, n * d.channels)
                            else w.write(buf.copyOfRange(from * d.channels, n * d.channels), (n - from) * d.channels)
                        }
                        done += n
                        progress(0.8f * (done.toFloat() / (d.frames + lat)).coerceIn(0f, 1f))
                    }
                }
            }
            val (lufs, tp) = Native.loudnessSummary(h).let { it[0] to it[1] }
            var gain = 0f
            if (targetLufs != null && lufs > -70f) gain = minOf(targetLufs - lufs, ceilingDb - tp)
            val g = Math.pow(10.0, gain / 20.0).toFloat()
            val out = Decoded(processed, d.name, d.sampleRate, d.channels, d.frames)
            if (m4a) encodeAac(out, g, dest, { progress(0.8f + 0.2f * it) }, cancelled)
            else writeWav(out, g, dest, { progress(0.8f + 0.2f * it) }, cancelled)
            progress(1f)
            return ExportResult(dest, lufs + gain, tp + gain, gain)
        } catch (e: Exception) {
            dest.delete()
            throw e
        } finally {
            Native.destroy(h)
            processed.delete()
        }
    }

    private fun writeWav(d: Decoded, gain: Float, dest: File, progress: (Float) -> Unit, cancelled: () -> Boolean) {
        val w = WavWriter(dest, d.sampleRate, d.channels)
        val buf = FloatArray(4096 * d.channels)
        var done = 0L
        FloatReader(d).use { r ->
            while (true) {
                if (cancelled()) { w.close(); throw CancelledException() }
                val n = r.read(buf, 4096)
                if (n == 0) break
                if (gain != 1f) for (i in 0 until n * d.channels) buf[i] *= gain
                w.write(buf, n * d.channels)
                done += n
                progress(done.toFloat() / d.frames)
            }
        }
        w.close()
    }

    private fun encodeAac(d: Decoded, gain: Float, dest: File, progress: (Float) -> Unit, cancelled: () -> Boolean) {
        val fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, d.sampleRate, d.channels).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, if (d.channels == 1) 160_000 else 256_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 16)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        codec.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        val muxer = MediaMuxer(dest.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var track = -1
        val info = MediaCodec.BufferInfo()
        var inDone = false
        var outDone = false
        var framesIn = 0L
        var floats = FloatArray(0)
        try {
            FloatReader(d).use { r ->
                while (!outDone) {
                    if (cancelled()) throw CancelledException()
                    if (!inDone) {
                        val i = codec.dequeueInputBuffer(10_000)
                        if (i >= 0) {
                            val buf = codec.getInputBuffer(i)!!.order(ByteOrder.LITTLE_ENDIAN)
                            buf.clear()
                            val maxFrames = minOf(buf.capacity() / (2 * d.channels), 4096)
                            if (floats.size < maxFrames * d.channels) floats = FloatArray(maxFrames * d.channels)
                            val n = r.read(floats, maxFrames)
                            val pts = framesIn * 1_000_000L / d.sampleRate
                            if (n == 0) {
                                codec.queueInputBuffer(i, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inDone = true
                            } else {
                                for (k in 0 until n * d.channels) buf.putShort((floats[k] * gain).coerceIn(-1f, 1f).times(32767f).toInt().toShort())
                                codec.queueInputBuffer(i, 0, n * d.channels * 2, pts, 0)
                                framesIn += n
                                progress(framesIn.toFloat() / d.frames)
                            }
                        }
                    }
                    val o = codec.dequeueOutputBuffer(info, 10_000)
                    if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                    } else if (o >= 0) {
                        val ob = codec.getOutputBuffer(o)!!
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0 && track >= 0) {
                            ob.position(info.offset)
                            ob.limit(info.offset + info.size)
                            muxer.writeSampleData(track, ob, info)
                        }
                        codec.releaseOutputBuffer(o, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
                    }
                }
            }
        } finally {
            runCatching { codec.stop() }
            codec.release()
            runCatching { if (track >= 0) muxer.stop() }
            muxer.release()
        }
    }
}

/**
 * Plays a decoded file through its own processor (mono or stereo, at the file's rate), with
 * seeking and A/B. Positions are in frames of the file.
 */
class FilePlayer(private val d: Decoded) {
    val handle: Long = Native.create(d.sampleRate, d.channels)
    @Volatile var playing = false
        private set
    @Volatile var position = 0L
        private set
    @Volatile private var seekTo = -1L
    private var thread: Thread? = null
    private var settings: ProcessorSettings? = null

    fun setSettings(s: ProcessorSettings) {
        settings = s
        Native.setChain(handle, s.chainJson, s.inputGainDb, s.outputGainDb, s.bypass)
    }

    fun seek(frame: Long) {
        seekTo = frame.coerceIn(0, d.frames)
        if (!playing) position = seekTo
    }

    @Synchronized
    fun play() {
        if (playing) return
        if (position >= d.frames) position = 0
        playing = true
        thread = Thread({ loop() }, "grit-player").apply { start() }
    }

    @Synchronized
    fun pause() {
        playing = false
        thread?.join(1000)
        thread = null
    }

    fun release() {
        pause()
        Native.destroy(handle)
    }

    private fun loop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
        val mask = if (d.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val min = AudioTrack.getMinBufferSize(d.sampleRate, mask, AudioFormat.ENCODING_PCM_FLOAT)
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(d.sampleRate).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setChannelMask(mask).build())
            .setBufferSizeInBytes(maxOf(min, 2048 * 4 * d.channels))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        val block = 1024
        val buf = FloatArray(block * d.channels)
        // The processor delays the sound by its latency: read ahead by that much so the position shown is what is heard
        val lat = Native.latency(handle).toLong()
        val reader = FloatReader(d)
        var readPos = position
        reader.seek(readPos)
        track.play()
        try {
            while (playing) {
                val s = seekTo
                if (s >= 0) {
                    seekTo = -1
                    readPos = s
                    reader.seek(s)
                }
                var n = reader.read(buf, block)
                if (n == 0) {
                    if (readPos >= d.frames + lat) break
                    n = block
                    buf.fill(0f)
                }
                Native.process(handle, buf, n)
                track.write(buf, 0, n * d.channels, AudioTrack.WRITE_BLOCKING)
                readPos += n
                position = (readPos - lat).coerceIn(0, d.frames)
            }
        } finally {
            reader.close()
            runCatching { track.stop() }
            track.release()
            if (readPos >= d.frames) position = d.frames
            playing = false
        }
    }
}
