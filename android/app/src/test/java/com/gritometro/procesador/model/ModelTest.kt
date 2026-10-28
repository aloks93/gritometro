package com.gritometro.procesador.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ModelTest {
    private val presetsJson = File("../../plugin/presets.json").readText()

    @Test
    fun chainPathsReadAndWrite() {
        val c = Chain("""{"comp1":{"on":false,"ratio":4},"eq":{"on":true,"bands":[{"on":true,"type":"peaking","freq":300}]}}""")
        assertEquals(4f, c.num("comp1.ratio"))
        assertEquals(300f, c.num("eq.bands.0.freq"))
        val d = c.withAll("comp1.on" to true, "eq.bands.0.freq" to 450f, "eq.bands.0.type" to "notch")
        assertTrue(d.bool("comp1.on"))
        assertEquals(450f, d.num("eq.bands.0.freq"))
        assertEquals("notch", d.str("eq.bands.0.type"))
        // The original is untouched
        assertFalse(c.bool("comp1.on"))
        val p = d.with("noise", org.json.JSONObject()).with("noise.profile", floatArrayOf(1f, 2f))
        assertEquals(2, p.profile()!!.size)
    }

    @Test
    fun builtInPresetsCoverEveryUseAndMic() {
        val p = Presets(presetsJson)
        assertTrue(p.uses.size >= 20)
        for (u in p.uses) for (m in u.mics) assertNotNull("${u.id}|$m", p.chain(u.id, m))
        assertTrue(p.isInstrument("guitar-clean"))
        assertFalse(p.isInstrument("singing"))
        assertEquals("lavalier", p.micFor("podcast", "lavalier"))
        assertEquals(p.use("guitar-clean")!!.defaultMic, p.micFor("guitar-clean", "lavalier"))
    }

    @Test
    fun presetFilesMatchThePcApp() {
        val text = PresetFiles.serialize("Mi voz", """{"comp1":{"on":true}}""")
        val (name, chain) = PresetFiles.parse(text)
        assertEquals("Mi voz", name)
        assertTrue(Chain(chain).bool("comp1.on"))
        assertTrue(runCatching { PresetFiles.parse("""{"app":"otra","chain":{}}""") }.isFailure)
        assertTrue(runCatching { PresetFiles.parse("nope") }.isFailure)
    }

    @Test
    fun assistantSetsGainGateAndCompressors() {
        val c = Chain(Presets(presetsJson).chain("speech", "lavalier")!!)
        val r = autoSetup(c, 0f, false, VoiceMeasurement(noiseDb = -60f, peakDb = -20f, speechDb = -32f, regions = null))
        assertTrue(r.applied)
        // Peaks land at −12 dBFS
        assertEquals(8f, r.inputGainDb)
        val speech = -32f + 8f
        val noise = -60f + 8f
        assertTrue(r.chain.bool("gate.on"))
        assertEquals(Math.round(minOf(speech - 8, maxOf(noise + 6, noise + (speech - noise) / 3))).toFloat(), r.chain.num("gate.thresholdDb"))
        assertEquals(Math.round(speech + 4).toFloat(), r.chain.num("comp1.thresholdDb"))
        assertEquals(Math.round(speech - 6).toFloat(), r.chain.num("deesser.thresholdDb"))
        // SNR 28 dB < 30: light noise reduction
        assertTrue(r.chain.bool("noise.on"))
        assertEquals(-12f, r.chain.num("noise.reductionDb"))
    }

    @Test
    fun assistantNeedsSound() {
        val r = autoSetup(Chain("{}"), 0f, false, VoiceMeasurement(-90f, -80f, -95f, null))
        assertFalse(r.applied)
        assertTrue(r.notes.first().contains("No se oyó"))
    }

    @Test
    fun assistantLeavesInstrumentsEqAlone() {
        val c = Chain(Presets(presetsJson).chain("guitar-clean", "di")!!)
        val regions = mapOf("low" to 0f, "mud" to 0f, "box" to 0f, "presence" to 0f, "air" to 0f)
        val r = autoSetup(c, 0f, true, VoiceMeasurement(-70f, -10f, -25f, regions))
        assertEquals(c.num("eq.bands.1.gainDb"), r.chain.num("eq.bands.1.gainDb"))
        assertEquals(c.bool("noise.on"), r.chain.bool("noise.on"))
    }

    @Test
    fun tunerFindsStrings() {
        val guitar = TUNINGS.first { it.id == "guitar" }
        val m = nearestString(110f, guitar)!!
        assertEquals("La2", m.name)
        assertTrue(kotlin.math.abs(m.cents) < 0.5f)
        assertNull(nearestString(110f, TUNINGS.first { it.id == "chromatic" }))
        assertEquals("La4", noteOf(440f).first)
        val s = PitchSmoother()
        listOf(100f, 101f, 300f).forEach { s.push(it) }
        assertEquals(300f, s.value())
    }
}
