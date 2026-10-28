package com.gritometro.procesador.audio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.os.Process
import java.io.File
import kotlin.math.log10

/**
 * Live processing: microphone → processor → headphones (monitor), optionally recorded.
 * One audio thread does everything: blocking read, process, write. Input and output may run on
 * different clocks (USB mic + headphones), so blocks are dropped when the output queue grows.
 */
class LiveEngine(private val context: Context) {
    val sampleRate = 48000
    private val block = 192

    data class Options(
        /** null = system default */
        val inputId: Int? = null,
        val outputId: Int? = null,
        /** 0 = first channel, 1 = second, -1 = both mixed (stereo inputs only) */
        val inputChannel: Int = 0,
        /** Ask for the raw microphone (no phone noise suppression / auto gain) */
        val unprocessed: Boolean = true,
        val monitor: Boolean = true,
        val monitorVolume: Float = 0.8f,
    )

    @Volatile var options = Options()
        private set
    @Volatile var handle = 0L
        private set
    @Volatile var running = false
        private set
    /** Set by the audio thread when the anti-howl guard muted the monitor */
    @Volatile var howlMuted = false
    @Volatile var error: String? = null
        private set

    private var settings: ProcessorSettings? = null
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null

    // Recording (written by the audio thread)
    private val recLock = Any()
    private var recProcessed: WavWriter? = null
    private var recRaw: WavWriter? = null
    @Volatile var recordingFrames = 0L
        private set

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    fun inputs(): List<AudioDeviceInfo> = am.getDevices(AudioManager.GET_DEVICES_INPUTS).filter { it.isSource }.toList()
    fun outputs(): List<AudioDeviceInfo> = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { it.isSink }.toList()

    fun setSettings(s: ProcessorSettings) {
        settings = s
        val h = handle
        if (h != 0L) Native.setChain(h, s.chainJson, s.inputGainDb, s.outputGainDb, s.bypass)
    }

    fun setOptions(o: Options) {
        val restart = running && (o.inputId != options.inputId || o.outputId != options.outputId || o.unprocessed != options.unprocessed)
        options = o
        if (o.monitor) howlMuted = false
        if (restart) {
            stop()
            start()
        }
    }

    /** The output the monitor will use (null = default route) */
    fun currentOutput(): AudioDeviceInfo? {
        track?.routedDevice?.let { return it }
        val id = options.outputId ?: return null
        return outputs().firstOrNull { it.id == id }
    }

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(): Boolean {
        if (running) return true
        error = null
        val o = options
        val inDev = o.inputId?.let { id -> inputs().firstOrNull { it.id == id } }
        val stereoIn = inDev != null && inDev.channelCounts.any { it >= 2 } && o.inputChannel != 0
        val chIn = if (stereoIn) 2 else 1
        val source = if (o.unprocessed && am.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true")
            MediaRecorder.AudioSource.UNPROCESSED else if (o.unprocessed) MediaRecorder.AudioSource.VOICE_RECOGNITION else MediaRecorder.AudioSource.MIC
        val inFormat = AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setChannelMask(if (chIn == 2) AudioFormat.CHANNEL_IN_STEREO else AudioFormat.CHANNEL_IN_MONO).build()
        val minIn = AudioRecord.getMinBufferSize(sampleRate, inFormat.channelMask, AudioFormat.ENCODING_PCM_FLOAT)
        val rec = try {
            AudioRecord.Builder().setAudioSource(source).setAudioFormat(inFormat)
                .setBufferSizeInBytes(maxOf(minIn, block * 4 * chIn * 4)).build()
        } catch (e: Exception) {
            error = "No se pudo abrir el micrófono: ${e.message}"
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            error = "No se pudo abrir el micrófono (¿lo está usando otra app?)."
            return false
        }
        inDev?.let { rec.setPreferredDevice(it) }

        val outFormat = AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()
        val minOut = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val trk = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(outFormat)
            .setBufferSizeInBytes(maxOf(minOut, block * 4 * 4))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build()
        o.outputId?.let { id -> outputs().firstOrNull { it.id == id }?.let { trk.setPreferredDevice(it) } }

        val h = Native.create(sampleRate, 1)
        settings?.let { Native.setChain(h, it.chainJson, it.inputGainDb, it.outputGainDb, it.bypass) }
        record = rec
        track = trk
        handle = h
        running = true
        howlMuted = false
        thread = Thread({ loop(rec, trk, h, chIn) }, "grit-audio").apply { start() }
        return true
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        thread?.join(1000)
        thread = null
        stopRecording()
        record?.let { runCatching { it.stop() }; it.release() }
        track?.let { runCatching { it.stop() }; it.release() }
        record = null
        track = null
        val h = handle
        handle = 0L
        if (h != 0L) Native.destroy(h)
    }

    fun startRecording(processed: File, raw: File?) {
        synchronized(recLock) {
            recProcessed = WavWriter(processed, sampleRate, 1)
            recRaw = raw?.let { WavWriter(it, sampleRate, 1) }
            recordingFrames = 0
        }
    }

    /** Closes the files; returns the processed one */
    fun stopRecording(): File? = synchronized(recLock) {
        val f = recProcessed?.let { it.close(); it.file }
        recRaw?.close()
        recProcessed = null
        recRaw = null
        f
    }

    val recording: Boolean get() = recProcessed != null

    private fun loop(rec: AudioRecord, trk: AudioTrack, h: Long, chIn: Int) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val inBuf = FloatArray(block * chIn)
        val mono = FloatArray(block)
        val raw = FloatArray(block)
        val out = FloatArray(block)
        var written = 0L
        var loudBlocks = 0
        try {
            rec.startRecording()
            trk.play()
        } catch (e: Exception) {
            error = "No se pudo iniciar el audio: ${e.message}"
            running = false
            return
        }
        val maxQueue = maxOf(trk.bufferSizeInFrames, block * 4) + block * 2
        while (running) {
            val n = rec.read(inBuf, 0, inBuf.size, AudioRecord.READ_BLOCKING)
            if (n <= 0) {
                if (n < 0) {
                    error = "Se perdió el micrófono (código $n)."
                    break
                }
                continue
            }
            val frames = n / chIn
            val ch = options.inputChannel
            for (i in 0 until frames) {
                mono[i] = when {
                    chIn == 1 -> inBuf[i]
                    ch == 1 -> inBuf[i * 2 + 1]
                    ch < 0 -> 0.5f * (inBuf[i * 2] + inBuf[i * 2 + 1])
                    else -> inBuf[i * 2]
                }
                raw[i] = mono[i]
            }
            Native.process(h, mono, frames)
            synchronized(recLock) {
                recProcessed?.let {
                    it.write(mono, frames)
                    recordingFrames = it.frames
                }
                recRaw?.write(raw, frames)
            }
            // Anti-howl guard: a long, very loud output while monitoring is almost always feedback
            var sum = 0.0
            for (i in 0 until frames) sum += mono[i] * mono[i]
            val rms = 10 * log10(sum / frames + 1e-12)
            loudBlocks = if (rms > -6) loudBlocks + 1 else 0
            if (loudBlocks * block > sampleRate * 3 / 4 && options.monitor && !howlMuted) howlMuted = true

            val o = options
            val gain = if (o.monitor && !howlMuted) o.monitorVolume * o.monitorVolume else 0f
            for (i in 0 until frames) out[i] = mono[i] * gain
            // Keep the output queue short: drop a block when the output runs slower than the input
            val queued = written - trk.playbackHeadPosition.toLong()
            if (queued > maxQueue) continue
            val w = trk.write(out, 0, frames, AudioTrack.WRITE_BLOCKING)
            if (w > 0) written += w
        }
        running = false
    }

    companion object {
        fun deviceName(d: AudioDeviceInfo): String {
            val type = when (d.type) {
                AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Micrófono del teléfono"
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Altavoz del teléfono"
                AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Auricular del teléfono"
                AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Audífonos con micrófono (cable)"
                AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Audífonos (cable)"
                AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB"
                AudioDeviceInfo.TYPE_USB_HEADSET -> "Audífonos USB"
                AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth"
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth (llamada)"
                AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "Bluetooth LE"
                AudioDeviceInfo.TYPE_TELEPHONY -> "Telefonía"
                else -> "Dispositivo"
            }
            val name = d.productName?.toString().orEmpty()
            val addr = if (d.type == AudioDeviceInfo.TYPE_BUILTIN_MIC && d.address.isNotBlank()) " (${d.address})" else ""
            return if (name.isBlank() || name == android.os.Build.MODEL) "$type$addr" else "$type · $name$addr"
        }

        fun isBluetooth(d: AudioDeviceInfo?): Boolean = d != null && d.type in setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER,
        )

        fun isSpeaker(d: AudioDeviceInfo?): Boolean = d == null || d.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    }
}
