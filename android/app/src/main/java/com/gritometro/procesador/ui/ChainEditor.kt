package com.gritometro.procesador.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.MainViewModel
import com.gritometro.procesador.Module
import com.gritometro.procesador.audio.Native
import com.gritometro.procesador.model.Chain
import kotlin.math.ln
import kotlin.math.pow

private val BAND_TYPES = listOf(
    "peaking" to "Campana", "lowshelf" to "Shelf graves", "highshelf" to "Shelf agudos",
    "highpass" to "Paso alto", "lowpass" to "Paso bajo", "notch" to "Notch", "bandpass" to "Paso banda",
)

private fun hasGain(t: String) = t == "peaking" || t == "lowshelf" || t == "highshelf"
private fun hasQ(t: String) = t != "lowshelf" && t != "highshelf"
private fun hasSlope(t: String) = t == "highpass" || t == "lowpass"

/** Gain reduction shown on each block, from the meters */
private fun moduleGr(m: Module, meters: FloatArray): Float = when (m) {
    Module.Noise -> meters[Native.M_NOISE]
    Module.Gate -> meters[Native.M_GATE]
    Module.DeEsser -> meters[Native.M_DEESS]
    Module.Comp1 -> meters[Native.M_COMP1]
    Module.Comp2 -> meters[Native.M_COMP2]
    Module.Limiter -> meters[Native.M_LIMITER]
    else -> 0f
}

/** The signal flow (tap a block to edit it) and the selected module's controls */
@Composable
fun ChainEditor(vm: MainViewModel, instrument: Boolean) {
    val chain = vm.chain
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Module.entries.forEachIndexed { i, m ->
            val on = m.key?.let { chain.bool("$it.on") } ?: true
            val sel = vm.module == m
            val gr = moduleGr(m, vm.meters)
            Column(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (sel) C.accent.copy(alpha = 0.18f) else C.panel2)
                    .border(1.dp, if (sel) C.accent else C.line, RoundedCornerShape(8.dp))
                    .clickable { vm.module = m }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Led(on)
                    Spacer(Modifier.width(6.dp))
                    Text(m.label, color = if (on) C.text else C.dim, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal)
                }
                Box(Modifier.padding(top = 4.dp).width(44.dp).height(3.dp).background(C.line2)) {
                    Box(Modifier.width((44 * (-gr / 18f).coerceIn(0f, 1f)).dp).height(3.dp).background(C.warn))
                }
            }
            if (i < Module.entries.size - 1) Icon(Icons.AutoMirrored.Filled.ArrowForward, null, tint = C.line2, modifier = Modifier.size(12.dp))
        }
    }
    Panel {
        ModuleHeader(vm, vm.module, instrument)
        when (vm.module) {
            Module.Gain -> GainPanel(vm)
            Module.Noise -> NoisePanel(vm)
            Module.Gate -> GatePanel(vm)
            Module.Eq -> EqPanel(vm)
            Module.DeEsser -> DeEsserPanel(vm)
            Module.Comp1 -> CompPanel(vm, "comp1")
            Module.Comp2 -> CompPanel(vm, "comp2")
            Module.Saturation -> SatPanel(vm)
            Module.Limiter -> LimiterPanel(vm)
        }
    }
}

@Composable
private fun ModuleHeader(vm: MainViewModel, m: Module, instrument: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(moduleTitle(m), color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text(moduleHint(m, instrument), color = C.dim, fontSize = 12.sp)
        }
        m.key?.let { k ->
            Switch(
                checked = vm.chain.bool("$k.on"),
                onCheckedChange = { vm.toggleModule(m) },
                colors = SwitchDefaults.colors(checkedTrackColor = C.accent),
            )
        }
    }
}

private fun moduleTitle(m: Module) = when (m) {
    Module.Gain -> "Ganancia de entrada y salida"
    Module.Noise -> "Reducción de ruido"
    Module.Gate -> "Puerta / expansor"
    Module.Eq -> "Ecualizador paramétrico"
    Module.DeEsser -> "De-esser"
    Module.Comp1 -> "Compresor 1"
    Module.Comp2 -> "Compresor 2"
    Module.Saturation -> "Saturador"
    Module.Limiter -> "Limitador true-peak"
}

private fun moduleHint(m: Module, instrument: Boolean) = when (m) {
    Module.Gain -> "Ajusta la entrada para que los picos queden cerca de −12 dB."
    Module.Noise -> if (instrument) "Con instrumentos recorta las colas de las notas: mejor usa la puerta." else "Quita el ruido constante: ventilador, aire, calle."
    Module.Gate -> "Silencia o baja el ruido entre frases."
    Module.Eq -> "Toca un punto para elegir la banda; arrástralo para moverla."
    Module.DeEsser -> if (instrument) "Para voces: con instrumentos déjalo apagado." else "Suaviza las eses y los sonidos silbantes."
    Module.Comp1 -> "Controla los picos: rápido y firme."
    Module.Comp2 -> "Nivela el volumen general: lento y suave."
    Module.Saturation -> "Calidez y presencia: válvula, cinta o amplificador."
    Module.Limiter -> "Nunca deja pasar picos por encima del techo."
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Knobs(vm: MainViewModel, params: List<Param>, chain: Chain = vm.chain) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        params.forEach { p -> Knob(chain.num(p.path, p.min), p, { vm.set(p.path, it) }) }
    }
}

@Composable
private fun Toggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { onChange(!checked) }) {
        Text(label, color = C.text, fontSize = 14.sp, modifier = Modifier.weight(1f))
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedTrackColor = C.accent))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GainPanel(vm: MainViewModel) {
    val pin = Param("in", "Entrada", -24f, 36f, "dB")
    val pout = Param("out", "Salida", -24f, 24f, "dB")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Knob(vm.inputGainDb, pin, { vm.setInputGain(it) }, default = 0f, size = 72.dp)
        Knob(vm.outputGainDb, pout, { vm.setOutputGain(it) }, default = 0f, size = 72.dp)
    }
    LevelBar("IN", vm.meters[Native.M_IN_PEAK], vm.meters[Native.M_IN_RMS])
    Text("Doble toque en una perilla la devuelve a 0 dB.", color = C.dim, fontSize = 12.sp)
}

@Composable
private fun NoisePanel(vm: MainViewModel) {
    val c = vm.chain
    Segmented(listOf("adaptive" to "Adaptativa", "learned" to "Perfil aprendido"), c.str("noise.mode", "adaptive"), { vm.set("noise.mode", it) })
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { vm.learnNoise() }, enabled = vm.meters[Native.M_LEARNING] == 0f) {
            Text(if (vm.meters[Native.M_LEARNING] > 0f) "Aprendiendo…" else "Aprender ruido (2 s de silencio)")
        }
        Spacer(Modifier.width(8.dp))
        Text(if (c.has("noise.profile")) "Perfil guardado" else "Sin perfil", color = if (c.has("noise.profile")) C.ok else C.dim, fontSize = 12.sp)
    }
    Knobs(
        vm,
        listOf(
            Param("noise.reductionDb", "Reducción", -40f, 0f, "dB"),
            Param("noise.sensitivityDb", "Sensibilidad", -10f, 10f, "dB"),
            Param("noise.smoothing", "Suavizado", 0f, 100f, "%", decimals = 0),
            Param("noise.fromHz", "Desde", 0f, 2000f, "Hz", Scale.Off, 0),
        ),
    )
    GrBar("Reducción", vm.meters[Native.M_NOISE], range = 40f)
    Toggle("Escuchar solo lo eliminado", c.bool("noise.listenRemoved")) { vm.set("noise.listenRemoved", it) }
}

@Composable
private fun GatePanel(vm: MainViewModel) {
    val c = vm.chain
    val mode = c.str("gate.mode", "expander")
    Segmented(listOf("expander" to "Expansor", "gate" to "Puerta"), mode, { vm.set("gate.mode", it) })
    LevelBar("IN", vm.meters[Native.M_IN_PEAK], vm.meters[Native.M_IN_RMS])
    Knobs(
        vm,
        listOfNotNull(
            Param("gate.thresholdDb", "Umbral", -90f, -10f, "dB"),
            Param("gate.rangeDb", "Rango", -80f, 0f, "dB"),
            if (mode == "expander") Param("gate.ratio", "Ratio", 1f, 10f, ":1") else null,
            Param("gate.hysteresisDb", "Histéresis", 0f, 20f, "dB"),
            Param("gate.attackMs", "Ataque", 0.1f, 50f, "ms", Scale.Log, 2),
            Param("gate.holdMs", "Mantener", 0f, 1000f, "ms", decimals = 0),
            Param("gate.releaseMs", "Liberación", 5f, 2000f, "ms", Scale.Log, 1),
            Param("gate.keyHpfHz", "Clave HPF", 0f, 1000f, "Hz", Scale.Off, 0),
            Param("gate.keyLpfHz", "Clave LPF", 0f, 20000f, "Hz", Scale.Off, 0),
        ),
    )
    GrBar("Atenuación", vm.meters[Native.M_GATE], range = 60f)
}

@Composable
private fun DeEsserPanel(vm: MainViewModel) {
    val c = vm.chain
    Segmented(listOf("split" to "Solo agudos", "wide" to "Banda ancha"), c.str("deesser.mode", "split"), { vm.set("deesser.mode", it) })
    Knobs(
        vm,
        listOf(
            Param("deesser.freq", "Frecuencia", 2000f, 12000f, "Hz", Scale.Log, 0),
            Param("deesser.q", "Ancho", 0.5f, 5f, "", Scale.Log, 2),
            Param("deesser.thresholdDb", "Umbral", -60f, 0f, "dB"),
            Param("deesser.ratio", "Ratio", 1f, 10f, ":1"),
            Param("deesser.rangeDb", "Máx.", -24f, 0f, "dB"),
        ),
    )
    GrBar("Reducción", vm.meters[Native.M_DEESS])
    Toggle("Escuchar solo la sibilancia", c.bool("deesser.listen")) { vm.set("deesser.listen", it) }
}

@Composable
private fun CompPanel(vm: MainViewModel, k: String) {
    val c = vm.chain
    Row(verticalAlignment = Alignment.CenterVertically) {
        CompCurve(c.num("$k.thresholdDb"), c.num("$k.ratio", 1f), c.num("$k.kneeDb"), Modifier.size(120.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Segmented(listOf("peak" to "Pico", "rms" to "RMS"), c.str("$k.detector", "peak"), { vm.set("$k.detector", it) })
            GrBar("Reducción", vm.meters[if (k == "comp1") Native.M_COMP1 else Native.M_COMP2])
        }
    }
    Knobs(
        vm,
        listOf(
            Param("$k.thresholdDb", "Umbral", -60f, 0f, "dB"),
            Param("$k.ratio", "Ratio", 1f, 20f, ":1", Scale.Log, 1),
            Param("$k.kneeDb", "Rodilla", 0f, 24f, "dB"),
            Param("$k.attackMs", "Ataque", 0.1f, 200f, "ms", Scale.Log, 1),
            Param("$k.releaseMs", "Liberación", 10f, 2000f, "ms", Scale.Log, 0),
            Param("$k.makeupDb", "Compensación", -12f, 24f, "dB"),
            Param("$k.mix", "Mezcla", 0f, 100f, "%", decimals = 0),
            Param("$k.scHpfHz", "SC HPF", 0f, 500f, "Hz", Scale.Off, 0),
        ),
    )
    Toggle("Compensación automática", c.bool("$k.autoMakeup")) { vm.set("$k.autoMakeup", it) }
}

@Composable
private fun SatPanel(vm: MainViewModel) {
    Segmented(listOf("tube" to "Válvula", "tape" to "Cinta", "amp" to "Ampli"), vm.chain.str("saturation.mode", "tube"), { vm.set("saturation.mode", it) })
    Knobs(
        vm,
        listOf(
            Param("saturation.driveDb", "Drive", 0f, 36f, "dB"),
            Param("saturation.toneHz", "Tono", 2000f, 20000f, "Hz", Scale.Log, 0),
            Param("saturation.mix", "Mezcla", 0f, 100f, "%", decimals = 0),
        ),
    )
}

@Composable
private fun LimiterPanel(vm: MainViewModel) {
    Knobs(
        vm,
        listOf(
            Param("limiter.ceilingDb", "Techo", -12f, 0f, "dBTP"),
            Param("limiter.releaseMs", "Liberación", 10f, 1000f, "ms", Scale.Log, 0),
        ),
    )
    GrBar("Reducción", vm.meters[Native.M_LIMITER], range = 12f)
    LevelBar("OUT", vm.meters[Native.M_OUT_PEAK], vm.meters[Native.M_OUT_RMS])
}

// ---- EQ

private const val F_MIN = 20f
private const val F_MAX = 20000f
private const val DB_RANGE = 18f

private fun xOfFreq(f: Float, w: Float) = (ln(f / F_MIN) / ln(F_MAX / F_MIN)) * w
private fun freqOfX(x: Float, w: Float) = F_MIN * (F_MAX / F_MIN).pow((x / w).coerceIn(0f, 1f))

@Composable
private fun EqPanel(vm: MainViewModel) {
    val c = vm.chain
    val bands = c.bandCount()
    if (bands == 0) return
    val sel = vm.selectedBand.coerceIn(0, bands - 1)
    EqGraph(vm, sel)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (i in 0 until bands) {
            val on = c.bool("eq.bands.$i.on")
            val s = i == sel
            Box(
                Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (s) C.accent.copy(alpha = 0.22f) else C.panel2)
                    .border(1.dp, if (s) C.accent else C.line, RoundedCornerShape(6.dp))
                    .clickable { vm.selectedBand = i }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            ) { Text("${i + 1}", color = if (on) C.text else C.dim, fontWeight = FontWeight.SemiBold) }
        }
    }
    val p = "eq.bands.$sel"
    val type = c.str("$p.type", "peaking")
    Toggle("Banda ${sel + 1} activa", c.bool("$p.on")) { vm.set("$p.on", it) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        BAND_TYPES.forEach { (t, label) ->
            val s = t == type
            Box(
                Modifier
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (s) C.accent.copy(alpha = 0.22f) else C.panel2)
                    .clickable { vm.set("$p.type", t) }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) { Text(label, color = if (s) C.accent else C.text, fontSize = 12.sp) }
        }
    }
    Knobs(
        vm,
        listOfNotNull(
            Param("$p.freq", "Frecuencia", 20f, 20000f, "Hz", Scale.Log, 0),
            if (hasGain(type)) Param("$p.gainDb", "Ganancia", -24f, 24f, "dB") else null,
            if (hasQ(type)) Param("$p.q", "Q", 0.1f, 20f, "", Scale.Log, 2) else null,
        ),
    )
    if (hasSlope(type)) {
        Segmented(listOf("12", "24", "36", "48").map { it to "$it dB/oct" }, c.num("$p.slope", 12f).toInt().toString(), { vm.set("$p.slope", it.toInt()) })
    }
    Toggle("Ecualizador activo", c.bool("eq.on", true)) { vm.set("eq.on", it) }
}

@Composable
private fun EqGraph(vm: MainViewModel, sel: Int) {
    val c = vm.chain
    val rate = vm.meterRate.toFloat()
    val points = 160
    val freqs = remember { FloatArray(points) { F_MIN * (F_MAX / F_MIN).pow(it / (points - 1f)) } }
    val response = remember(c.json, rate) { FloatArray(points).also { Native.eqResponse(c.json, rate, freqs, it) } }
    val bands = c.bandCount()
    val chainNow by rememberUpdatedState(c)
    val selNow by rememberUpdatedState(sel)
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(190.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF07090C))
            .pointerInput(bands) {
                fun nearest(o: Offset): Int {
                    var best = selNow
                    var bestD = Float.MAX_VALUE
                    for (i in 0 until bands) {
                        val ch = chainNow
                        val x = xOfFreq(ch.num("eq.bands.$i.freq", 1000f), size.width.toFloat())
                        val g = if (hasGain(ch.str("eq.bands.$i.type"))) ch.num("eq.bands.$i.gainDb") else 0f
                        val y = size.height / 2f - g / DB_RANGE * size.height / 2f
                        val d = (x - o.x) * (x - o.x) + (y - o.y) * (y - o.y)
                        if (d < bestD) { bestD = d; best = i }
                    }
                    return best
                }
                detectTapGestures { o -> vm.selectedBand = nearest(o) }
            }
            .pointerInput(bands) {
                var band = 0
                detectDragGestures(onDragStart = { o ->
                    var bestD = Float.MAX_VALUE
                    for (i in 0 until bands) {
                        val ch = chainNow
                        val x = xOfFreq(ch.num("eq.bands.$i.freq", 1000f), size.width.toFloat())
                        val g = if (hasGain(ch.str("eq.bands.$i.type"))) ch.num("eq.bands.$i.gainDb") else 0f
                        val y = size.height / 2f - g / DB_RANGE * size.height / 2f
                        val d = (x - o.x) * (x - o.x) + (y - o.y) * (y - o.y)
                        if (d < bestD) { bestD = d; band = i }
                    }
                    vm.selectedBand = band
                }) { change, _ ->
                    change.consume()
                    val ch = chainNow
                    val w = size.width.toFloat()
                    val f = freqOfX(change.position.x, w)
                    var next = ch.with("eq.bands.$band.freq", Math.round(f).toFloat())
                    if (hasGain(ch.str("eq.bands.$band.type"))) {
                        val g = ((size.height / 2f - change.position.y) / (size.height / 2f) * DB_RANGE).coerceIn(-24f, 24f)
                        next = next.with("eq.bands.$band.gainDb", Math.round(g * 10) / 10f)
                    }
                    if (!ch.bool("eq.bands.$band.on")) next = next.with("eq.bands.$band.on", true)
                    vm.replaceChain(next)
                }
            },
    ) {
        val w = size.width
        val h = size.height
        // Grid: decades and ±6 dB lines
        for (f in listOf(50f, 100f, 200f, 500f, 1000f, 2000f, 5000f, 10000f)) {
            val x = xOfFreq(f, w)
            drawLine(C.line, Offset(x, 0f), Offset(x, h), 1f)
        }
        for (db in listOf(-12f, -6f, 0f, 6f, 12f)) {
            val y = h / 2 - db / DB_RANGE * h / 2
            drawLine(if (db == 0f) C.line2 else C.line, Offset(0f, y), Offset(w, y), 1f)
        }
        drawSpectrum(vm.spectrumIn, rate, C.dim.copy(alpha = 0.35f))
        drawSpectrum(vm.spectrumOut, rate, C.teal.copy(alpha = 0.55f))
        // Response curve
        val path = Path()
        for (i in 0 until points) {
            val x = xOfFreq(freqs[i], w)
            val y = h / 2 - response[i].coerceIn(-DB_RANGE * 1.5f, DB_RANGE * 1.5f) / DB_RANGE * h / 2
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        drawPath(path, if (c.bool("eq.on", true)) C.accent else C.dim, style = Stroke(2.5.dp.toPx()))
        for (i in 0 until bands) {
            val t = c.str("eq.bands.$i.type")
            val x = xOfFreq(c.num("eq.bands.$i.freq", 1000f), w)
            val g = if (hasGain(t)) c.num("eq.bands.$i.gainDb") else 0f
            val y = h / 2 - g / DB_RANGE * h / 2
            val on = c.bool("eq.bands.$i.on")
            val col = if (i == sel) C.warn else if (on) C.text else C.dim
            drawCircle(col, if (i == sel) 9.dp.toPx() else 6.dp.toPx(), Offset(x, y), style = if (on) androidx.compose.ui.graphics.drawscope.Fill else Stroke(2f))
        }
    }
}

private fun DrawScope.drawSpectrum(spec: FloatArray, rate: Float, color: Color) {
    if (spec.isEmpty()) return
    val w = size.width
    val h = size.height
    val binHz = rate / Native.FFT
    val path = Path()
    var started = false
    // One point per ~3 px, the loudest bin in between (log axis)
    val cols = (w / 3).toInt()
    for (cx in 0..cols) {
        val f0 = freqOfX(cx * 3f, w)
        val f1 = freqOfX((cx + 1) * 3f, w)
        val b0 = (f0 / binHz).toInt().coerceIn(1, spec.size - 1)
        val b1 = (f1 / binHz).toInt().coerceIn(b0, spec.size - 1)
        var m = -140f
        for (b in b0..b1) m = maxOf(m, spec[b])
        // −90..−10 dBFS mapped onto the graph
        val y = h - ((m + 90f) / 80f).coerceIn(0f, 1f) * h
        if (!started) { path.moveTo(cx * 3f, h); started = true }
        path.lineTo(cx * 3f, y)
    }
    path.lineTo(w, h)
    path.close()
    drawPath(path, color)
}

@Composable
private fun CompCurve(threshold: Float, ratio: Float, knee: Float, modifier: Modifier) {
    Canvas(modifier.clip(RoundedCornerShape(8.dp)).background(Color(0xFF07090C))) {
        val w = size.width
        val h = size.height
        val lo = -60f
        fun x(db: Float) = (db - lo) / -lo * w
        fun y(db: Float) = h - (db - lo) / -lo * h
        for (db in listOf(-48f, -36f, -24f, -12f)) {
            drawLine(C.line, Offset(x(db), 0f), Offset(x(db), h), 1f)
            drawLine(C.line, Offset(0f, y(db)), Offset(w, y(db)), 1f)
        }
        drawLine(C.line2, Offset(0f, h), Offset(w, 0f), 1f)
        val path = Path()
        for (i in 0..60) {
            val inDb = lo + i
            val out = Native.compCurve(inDb, threshold, ratio, knee)
            if (i == 0) path.moveTo(x(inDb), y(out)) else path.lineTo(x(inDb), y(out))
        }
        drawPath(path, C.accent, style = Stroke(2.dp.toPx()))
        drawCircle(C.warn, 3.dp.toPx(), Offset(x(threshold), y(threshold)))
    }
}
