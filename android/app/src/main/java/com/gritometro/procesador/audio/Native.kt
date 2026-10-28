package com.gritometro.procesador.audio

/**
 * The processor DSP (android/native, Rust: the plugin's dsp.rs). A handle is one processor
 * instance; every call is thread-safe (the native side keeps it behind a mutex).
 */
object Native {
    init {
        System.loadLibrary("gritometro_android")
    }

    /** Indexes of [meters]' array */
    const val M_IN_PEAK = 0
    const val M_IN_RMS = 1
    const val M_OUT_PEAK = 2
    const val M_OUT_RMS = 3
    const val M_NOISE = 4
    const val M_GATE = 5
    const val M_DEESS = 6
    const val M_COMP1 = 7
    const val M_COMP2 = 8
    const val M_LIMITER = 9
    const val M_LUFS_M = 10
    const val M_LUFS_S = 11
    const val M_TRUE_PEAK = 12
    const val M_LEARNING = 13
    const val M_LATENCY_MS = 14
    const val METERS = 15

    /** Samples of the spectrum's FFT; [spectrum] fills FFT / 2 bins */
    const val FFT = 4096

    @JvmStatic external fun create(sampleRate: Int, channels: Int): Long
    @JvmStatic external fun destroy(handle: Long)
    @JvmStatic external fun setChain(handle: Long, json: String, inputGainDb: Float, outputGainDb: Float, bypass: Boolean)
    @JvmStatic external fun process(handle: Long, buf: FloatArray, frames: Int)
    @JvmStatic external fun latency(handle: Long): Int
    @JvmStatic external fun meters(handle: Long, out: FloatArray)
    @JvmStatic external fun spectrum(handle: Long, output: Boolean, out: FloatArray)
    @JvmStatic external fun pitch(handle: Long, minHz: Float, maxHz: Float): FloatArray?
    @JvmStatic external fun learnNoise(handle: Long, seconds: Float)
    @JvmStatic external fun isLearning(handle: Long): Boolean
    @JvmStatic external fun takeLearnedProfile(handle: Long): FloatArray?
    @JvmStatic external fun resetLoudness(handle: Long)
    @JvmStatic external fun loudnessSummary(handle: Long): FloatArray
    @JvmStatic external fun normalizeChain(json: String): String
    @JvmStatic external fun eqResponse(json: String, sampleRate: Float, freqs: FloatArray, out: FloatArray)
    @JvmStatic external fun compCurve(inDb: Float, thresholdDb: Float, ratio: Float, kneeDb: Float): Float
}

/** What every processor instance gets from the UI: the chain and the processor's gains */
data class ProcessorSettings(
    val chainJson: String,
    val inputGainDb: Float,
    val outputGainDb: Float,
    val bypass: Boolean,
)
