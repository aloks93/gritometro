package com.gritometro.procesador.model

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// The automatic assistant, as autoSetup() in core/processor/processor.ts: 3 s of silence, then
// 8 s of normal speech (or playing), turned into gain, gate, compressors, de-esser and EQ fixes.

const val GAIN_MIN = -24f
const val GAIN_MAX = 36f

data class VoiceMeasurement(
    /** Room RMS with nobody talking, dBFS (at the current input gain) */
    val noiseDb: Float,
    /** Loudest peak while talking, dBFS */
    val peakDb: Float,
    /** Average RMS of the voiced parts, dBFS */
    val speechDb: Float,
    /** Average voiced spectrum level per region (relative values matter) */
    val regions: Map<String, Float>?,
)

/** Long-term average speech spectrum relative to the presence region, dB */
val VOICE_TARGET = mapOf("low" to 20f, "mud" to 21f, "box" to 15f, "presence" to 0f, "air" to -12f)

val VOICE_REGIONS = mapOf(
    "low" to (100f to 200f),
    "mud" to (200f to 400f),
    "box" to (500f to 1000f),
    "presence" to (2000f to 5000f),
    "air" to (8000f to 12000f),
)

data class AutoSetupResult(val chain: Chain, val inputGainDb: Float, val notes: List<String>, val applied: Boolean)

private fun half(v: Float): Float = (v * 2).roundToInt() / 2f

fun autoSetup(chain: Chain, inputGainDb: Float, instrument: Boolean, m: VoiceMeasurement): AutoSetupResult {
    val notes = mutableListOf<String>()
    if (m.peakDb <= -70 || m.speechDb <= -80) {
        notes += if (instrument) "No se oyó el instrumento: revisa el cable y su volumen, y repite." else "No se oyó la voz: revisa el micrófono y repite."
        return AutoSetupResult(chain, inputGainDb, notes, false)
    }
    val gain = half(max(GAIN_MIN, min(GAIN_MAX, inputGainDb - 12 - m.peakDb)))
    val delta = gain - inputGainDb
    val noise = m.noiseDb + delta
    val speech = m.speechDb + delta
    val snr = speech - noise
    if (gain >= GAIN_MAX) notes += "Ganancia digital al máximo: sube el volumen del micrófono o de la interfaz."
    if (snr < 15) notes += if (instrument) "Mucho ruido para el instrumento: revisa cables y aléjalo de cargadores y pantallas."
    else "Mucho ruido de fondo para la voz: acércate al micrófono o baja el ruido del lugar."

    // Gate a third of the way from the noise to the voice (a quarter for instruments)
    val thr = min(speech - 8, max(noise + 6, noise + snr / (if (instrument) 4 else 3))).roundToInt().toFloat()
    var c = chain.withAll("gate.on" to (snr >= 10), "gate.thresholdDb" to thr)
    if (snr < 10) notes += if (instrument) "Instrumento y ruido demasiado cerca: la puerta queda apagada para no cortar notas."
    else "Voz y ruido demasiado cerca: la puerta queda apagada para no cortar palabras."

    c = c.withAll(
        "comp1.on" to true,
        "comp1.thresholdDb" to (speech + 4).roundToInt().toFloat(),
        "comp2.thresholdDb" to (speech - 2).roundToInt().toFloat(),
    )
    if (instrument) {
        notes.add(0, "Ganancia $gain dB · ruido ${noise.roundToInt()} dBFS · instrumento ${speech.roundToInt()} dBFS")
        return AutoSetupResult(c, gain, notes, true)
    }
    if (snr < 30) {
        c = c.withAll("noise.on" to true, "noise.reductionDb" to (if (snr < 18) -20f else -12f))
        notes += "Reducción de ruido activada."
    }
    c = c.with("deesser.thresholdDb", (speech - 6).roundToInt().toFloat())

    m.regions?.let { r ->
        val p = r["presence"] ?: return@let
        fun fix(diff: Float, mx: Float) = half(max(-mx, min(mx, -diff * 0.6f)))
        val corr = mapOf(
            "low" to fix(r["low"]!! - p - VOICE_TARGET["low"]!!, 4f),
            "mud" to fix(r["mud"]!! - p - VOICE_TARGET["mud"]!!, 4f),
            "box" to fix(r["box"]!! - p - VOICE_TARGET["box"]!!, 3f),
            "air" to fix(r["air"]!! - p - VOICE_TARGET["air"]!!, 3f),
        )
        fun nudge(i: Int, type: String, freq: Float, d: Float, label: String) {
            if (i >= c.bandCount() || abs(d) < 1) return
            c = c.withAll(
                "eq.bands.$i.on" to true,
                "eq.bands.$i.type" to type,
                "eq.bands.$i.freq" to freq,
                "eq.bands.$i.gainDb" to max(-12f, min(12f, d)),
            )
            if (type == "peaking") c = c.with("eq.bands.$i.q", 1.2f)
            notes += "$label: ${if (d > 0) "+" else ""}$d dB"
        }
        nudge(1, "lowshelf", 150f, corr["low"]!!, "Graves")
        nudge(2, "peaking", 300f, corr["mud"]!!, "Barro (300 Hz)")
        nudge(3, "peaking", 800f, corr["box"]!!, "Caja (800 Hz)")
        nudge(6, "highshelf", 10000f, corr["air"]!!, "Aire")
        c = c.with("eq.on", true)
    }
    notes.add(0, "Ganancia $gain dB · ruido ${noise.roundToInt()} dBFS · voz ${speech.roundToInt()} dBFS")
    return AutoSetupResult(c, gain, notes, true)
}
