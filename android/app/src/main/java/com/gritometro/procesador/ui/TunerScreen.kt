package com.gritometro.procesador.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.MainViewModel
import com.gritometro.procesador.model.TUNINGS
import com.gritometro.procesador.model.nearestString
import com.gritometro.procesador.model.noteOf
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

@Composable
fun TunerScreen(vm: MainViewModel) {
    val tuning = TUNINGS.firstOrNull { it.id == vm.tuningId } ?: TUNINGS[0]
    val hz = vm.pitchHz
    val match = hz?.let { nearestString(it, tuning, vm.a4) }
    val (name, cents) = when {
        hz == null -> "—" to 0f
        match != null -> match.name to match.cents
        else -> noteOf(hz, vm.a4)
    }
    val inTune = hz != null && abs(cents) <= 5
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (!vm.liveOn) {
            Banner("El afinador escucha el micrófono o la interfaz. Enciende el procesador para empezar.", C.accent)
            Button(onClick = { vm.startLive() }, modifier = Modifier.fillMaxWidth()) { Text("Encender micrófono") }
        }
        var open by remember { mutableStateOf(false) }
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(tuning.name, color = C.text) }
            DropdownMenu(open, { open = false }) {
                TUNINGS.forEach { t ->
                    DropdownMenuItem(text = { Text(t.name) }, onClick = {
                        vm.tuningId = t.id
                        vm.persistLater()
                        open = false
                    })
                }
            }
        }
        Panel {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(name, color = if (inTune) C.ok else C.text, fontSize = 72.sp, fontWeight = FontWeight.Bold)
                Text(
                    if (hz == null) "Toca una nota" else String.format(Locale.US, "%.1f Hz · %+d cents", hz, cents.roundToInt()),
                    color = C.dim, fontSize = 15.sp, fontFamily = Mono,
                )
                if (match != null) Text(String.format(Locale.US, "Cuerda %d · objetivo %.1f Hz", tuning.strings.size - match.index, match.targetHz), color = C.dim, fontSize = 13.sp)
                Canvas(Modifier.fillMaxWidth().height(70.dp).padding(top = 12.dp)) {
                    val w = size.width
                    val h = size.height
                    for (c in -50..50 step 10) {
                        val x = w / 2 + c / 50f * (w / 2 - 8)
                        val big = c % 50 == 0 || c == 0
                        drawLine(if (c == 0) C.ok else C.line2, Offset(x, if (big) 0f else h * 0.3f), Offset(x, h * 0.7f), if (c == 0) 3f else 2f)
                    }
                    if (hz != null) {
                        val x = w / 2 + cents.coerceIn(-50f, 50f) / 50f * (w / 2 - 8)
                        drawLine(if (inTune) C.ok else if (abs(cents) < 20) C.warn else C.bad, Offset(x, 0f), Offset(x, h), 6f, StrokeCap.Round)
                    }
                }
                Text(if (hz == null) "" else if (inTune) "Afinado" else if (cents < 0) "Sube (está bajo)" else "Baja (está alto)", color = if (inTune) C.ok else C.warn, fontSize = 16.sp)
            }
        }
        if (tuning.strings.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                tuning.strings.forEachIndexed { i, midi ->
                    val active = match?.index == i
                    Box(
                        Modifier.weight(1f).clip(RoundedCornerShape(8.dp))
                            .background(if (active) (if (inTune) C.ok else C.accent).copy(alpha = 0.25f) else C.panel2)
                            .border(1.dp, if (active) C.accent else C.line, RoundedCornerShape(8.dp))
                            .padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) { Text(com.gritometro.procesador.model.midiName(midi), color = C.text, fontSize = 13.sp) }
                }
            }
        }
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("La4 de referencia", color = C.text, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { vm.a4 = (vm.a4 - 1).coerceAtLeast(415f); vm.persistLater() }) { Text("−") }
                Text(" ${vm.a4.roundToInt()} Hz ", color = C.text, fontFamily = Mono, modifier = Modifier.clickable { vm.a4 = 440f; vm.persistLater() })
                OutlinedButton(onClick = { vm.a4 = (vm.a4 + 1).coerceAtMost(466f); vm.persistLater() }) { Text("+") }
            }
        }
        Box(Modifier.size(1.dp))
    }
}
