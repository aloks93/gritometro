package com.gritometro.procesador.model

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt

// Instrument tuner, as core/processor/tuning.ts: string tunings and the nearest string to a pitch

data class Tuning(val id: String, val name: String, val strings: List<Int>)

val TUNINGS = listOf(
    Tuning("chromatic", "Cromático", emptyList()),
    Tuning("bass4", "Bajo 4 cuerdas (Mi La Re Sol)", listOf(28, 33, 38, 43)),
    Tuning("bass5", "Bajo 5 cuerdas (Si Mi La Re Sol)", listOf(23, 28, 33, 38, 43)),
    Tuning("bass6", "Bajo 6 cuerdas (Si Mi La Re Sol Do)", listOf(23, 28, 33, 38, 43, 48)),
    Tuning("bass4-dropd", "Bajo Drop D (Re La Re Sol)", listOf(26, 33, 38, 43)),
    Tuning("bass4-half", "Bajo ½ tono abajo (Mi♭)", listOf(27, 32, 37, 42)),
    Tuning("guitar", "Guitarra estándar (Mi La Re Sol Si Mi)", listOf(40, 45, 50, 55, 59, 64)),
    Tuning("guitar-dropd", "Guitarra Drop D", listOf(38, 45, 50, 55, 59, 64)),
    Tuning("guitar-half", "Guitarra ½ tono abajo (Mi♭)", listOf(39, 44, 49, 54, 58, 63)),
    Tuning("guitar-dadgad", "Guitarra DADGAD", listOf(38, 45, 50, 55, 57, 62)),
    Tuning("guitar7", "Guitarra 7 cuerdas (Si…)", listOf(35, 40, 45, 50, 55, 59, 64)),
    Tuning("ukulele", "Ukelele (Sol Do Mi La)", listOf(67, 60, 64, 69)),
    Tuning("violin", "Violín (Sol Re La Mi)", listOf(55, 62, 69, 76)),
)

private val SOLFEGE = listOf("Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si")

fun midiHz(midi: Int, a4: Float = 440f): Float = a4 * 2f.pow((midi - 69) / 12f)
fun midiName(midi: Int): String = "${SOLFEGE[((midi % 12) + 12) % 12]}${floor(midi / 12.0).toInt() - 1}"
fun cents(hz: Float, target: Float): Float = (1200 * ln(hz / target) / ln(2f))

data class StringMatch(val index: Int, val midi: Int, val name: String, val targetHz: Float, val cents: Float)

fun nearestString(hz: Float, tuning: Tuning, a4: Float = 440f): StringMatch? {
    if (tuning.strings.isEmpty() || hz <= 0f) return null
    return tuning.strings.mapIndexed { i, m -> StringMatch(i, m, midiName(m), midiHz(m, a4), cents(hz, midiHz(m, a4))) }.minByOrNull { abs(it.cents) }
}

/** Nearest tempered note: (name, cents) */
fun noteOf(hz: Float, a4: Float = 440f): Pair<String, Float> {
    val exact = 69 + 12 * ln(hz / a4) / ln(2f)
    val midi = exact.roundToInt()
    return midiName(midi) to (exact - midi) * 100
}

fun tunerMinHz(tuning: Tuning, a4: Float = 440f): Float =
    if (tuning.strings.isEmpty()) 27f else maxOf(25f, midiHz(tuning.strings.min(), a4) * 0.8f)

/** Median of the last pitches; a jump of more than a semitone restarts (a new note) */
class PitchSmoother(private val size: Int = 5) {
    private val hist = ArrayDeque<Float>()

    fun push(hz: Float): Float {
        value()?.let { if (abs(cents(hz, it)) > 100) hist.clear() }
        hist.addLast(hz)
        if (hist.size > size) hist.removeFirst()
        return value()!!
    }

    fun value(): Float? = if (hist.isEmpty()) null else hist.sorted()[hist.size / 2]
    fun reset() = hist.clear()
}
