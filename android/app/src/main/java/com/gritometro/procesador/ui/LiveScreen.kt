package com.gritometro.procesador.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoFixHigh
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.MainViewModel
import com.gritometro.procesador.audio.Native
import java.util.Locale

@Composable
fun PresetHeader(vm: MainViewModel, onPresets: () -> Unit, onSettings: (() -> Unit)?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(10.dp))
                .background(C.panel)
                .border(1.dp, C.line, RoundedCornerShape(10.dp))
                .clickable { onPresets() }
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Tune, null, tint = C.accent, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("Preset", color = C.dim, fontSize = 11.sp)
                Text(
                    vm.presetLabel + if (vm.modified) " (modificado)" else "",
                    color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (onSettings != null) {
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, "Ajustes", tint = C.text) }
        }
    }
}

@Composable
fun MetersPanel(vm: MainViewModel) {
    val m = vm.meters
    Panel {
        LevelBar("IN", m[Native.M_IN_PEAK], m[Native.M_IN_RMS])
        LevelBar("OUT", m[Native.M_OUT_PEAK], m[Native.M_OUT_RMS])
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Stat("LUFS (3 s)", if (m[Native.M_LUFS_S] <= -99f) "—" else String.format(Locale.US, "%.1f", m[Native.M_LUFS_S]))
            Stat("Pico real", if (m[Native.M_TRUE_PEAK] <= -99f) "—" else String.format(Locale.US, "%.1f dBTP", m[Native.M_TRUE_PEAK]))
            Stat("Latencia", String.format(Locale.US, "%.0f ms", m[Native.M_LATENCY_MS]))
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column {
        Text(label, color = C.dim, fontSize = 11.sp)
        Text(value, color = C.text, fontSize = 14.sp, fontFamily = Mono)
    }
}

/** Press and hold: sends the unprocessed signal (A/B) */
@Composable
fun HoldButton(label: String, onHold: (Boolean) -> Unit, modifier: Modifier = Modifier, active: Boolean = false) {
    Box(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(if (active) C.warn.copy(alpha = 0.25f) else C.panel2)
            .border(1.dp, if (active) C.warn else C.line2, RoundedCornerShape(12.dp))
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown()
                    onHold(true)
                    waitForUpOrCancellation()
                    onHold(false)
                }
            }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("A/B", color = if (active) C.warn else C.text, fontWeight = FontWeight.Bold, fontSize = 15.sp)
            Text(label, color = C.dim, fontSize = 10.sp)
        }
    }
}

@Composable
fun RoundAction(icon: ImageVector, label: String, color: Color, active: Boolean, onClick: () -> Unit, size: Int = 56) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(size.dp)
                .clip(CircleShape)
                .background(if (active) color else C.panel2)
                .border(2.dp, color, CircleShape)
                .clickable { onClick() },
            contentAlignment = Alignment.Center,
        ) { Icon(icon, label, tint = if (active) C.bg else color, modifier = Modifier.size((size * 0.5).dp)) }
        Text(label, color = C.dim, fontSize = 11.sp)
    }
}

@Composable
fun LiveScreen(vm: MainViewModel, onPresets: () -> Unit, onSettings: () -> Unit) {
    val instrument = vm.presets.isInstrument(vm.useId)
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            PresetHeader(vm, onPresets, onSettings)
            if (vm.howl) Banner("Se detectó un pitido (acople) y se silenció la escucha. Usa audífonos y vuelve a activar la escucha.", C.bad)
            vm.outputWarning?.let { if (vm.liveOn) Banner(it) }
            if (!vm.liveOn) Banner("Conecta audífonos, elige un preset y toca el botón de encendido. Te escucharás ya procesado.", C.accent)
            MetersPanel(vm)
            ChainEditor(vm, instrument)
            Spacer(Modifier.height(4.dp))
        }
        // Transport bar
        Row(
            Modifier.fillMaxWidth().background(C.panel).padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundAction(Icons.Default.PowerSettingsNew, if (vm.liveOn) "Encendido" else "Apagado", C.ok, vm.liveOn, { vm.toggleLive() }, 62)
            HoldButton("mantén", { vm.setAb(it) }, active = vm.abHeld)
            RoundAction(Icons.Default.Headphones, if (vm.options.monitor) "Escucha" else "Sin escucha", C.accent, vm.options.monitor, {
                vm.updateOptions(vm.options.copy(monitor = !vm.options.monitor))
            })
            val rec = vm.recordingSeconds
            RoundAction(if (rec != null) Icons.Default.Stop else Icons.Default.FiberManualRecord, rec?.let { formatTime(it.toDouble()) } ?: "Grabar", C.bad, rec != null, { vm.toggleRecording() })
            RoundAction(Icons.Default.AutoFixHigh, "Asistente", C.teal, false, { vm.openAssistant() })
        }
    }
}
