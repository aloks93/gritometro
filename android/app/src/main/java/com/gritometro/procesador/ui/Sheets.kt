package com.gritometro.procesador.ui

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.AssistantPhase
import com.gritometro.procesador.MainViewModel
import com.gritometro.procesador.audio.LiveEngine

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) C.accent.copy(alpha = 0.22f) else C.panel2)
            .border(1.dp, if (selected) C.accent else C.line, RoundedCornerShape(16.dp))
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 7.dp),
    ) { Text(label, color = if (selected) C.accent else C.text, fontSize = 13.sp, maxLines = 1) }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun PresetSheet(vm: MainViewModel, onDismiss: () -> Unit, onImport: () -> Unit, onExport: () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var page by remember { mutableStateOf("uses") }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = C.bg) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Segmented(listOf("uses" to "Uso y micrófono", "mine" to "Mis presets"), page, { page = it })
            if (page == "uses") {
                vm.presets.groups.forEach { (g, label) ->
                    val uses = vm.presets.uses.filter { it.group == g }
                    if (uses.isEmpty()) return@forEach
                    Text(label, color = C.dim, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        uses.forEach { u -> Chip(u.name, u.id == vm.useId) { vm.selectUse(u.id) } }
                    }
                }
                val use = vm.presets.use(vm.useId)
                if (use != null) {
                    Panel {
                        Text(use.name, color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Text(use.hint, color = C.dim, fontSize = 13.sp)
                        Text("Micrófono o captación", color = C.dim, fontSize = 12.sp)
                        vm.presets.micGroups.forEach { (g, label) ->
                            val mics = use.mics.mapNotNull { vm.presets.mic(it) }.filter { it.group == g }
                            if (mics.isEmpty()) return@forEach
                            Text(label, color = C.dim, fontSize = 11.sp)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                mics.forEach { m -> Chip(m.name, m.id == vm.micId) { vm.applyPreset(use.id, m.id) } }
                            }
                        }
                        vm.presets.mic(vm.micId)?.let { Text(it.hint, color = C.dim, fontSize = 12.sp) }
                    }
                    Text("Con el micrófono del propio teléfono elige «Corbatero (lavalier)»: es omnidireccional y pequeño, como él.", color = C.dim, fontSize = 12.sp)
                }
            } else {
                var name by remember { mutableStateOf("") }
                Panel {
                    Text("Guardar la configuración actual", color = C.text, fontWeight = FontWeight.SemiBold)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(name, { name = it }, singleLine = true, placeholder = { Text("Nombre") }, modifier = Modifier.weight(1f))
                        Spacer(Modifier.width(8.dp))
                        Button(onClick = { vm.saveUserPreset(name); name = "" }) { Text("Guardar") }
                    }
                }
                if (vm.userPresets.isEmpty()) Text("Todavía no guardaste presets.", color = C.dim, fontSize = 13.sp)
                vm.userPresets.toList().forEach { p ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(C.panel).clickable { vm.loadUserPreset(p); onDismiss() }.padding(start = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(p.name, color = C.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        IconButton(onClick = { vm.deleteUserPreset(p) }) { Icon(Icons.Default.Delete, "Borrar", tint = C.dim) }
                    }
                }
                Text("Archivos de preset: los mismos que usan el Procesador de PC y el Plugin.", color = C.dim, fontSize = 12.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onImport) { Text("Importar archivo") }
                    OutlinedButton(onClick = onExport) { Text("Exportar archivo") }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(vm: MainViewModel, onDismiss: () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val o = vm.options
    val inputs = remember { vm.live.inputs() }
    val outputs = remember { vm.live.outputs().filter { it.type != android.media.AudioDeviceInfo.TYPE_TELEPHONY } }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = C.bg) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Entrada y salida", color = C.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            DevicePicker("Micrófono", inputs, o.inputId) { vm.updateOptions(o.copy(inputId = it)) }
            val dev = inputs.firstOrNull { it.id == o.inputId }
            if (dev != null && dev.channelCounts.any { it >= 2 }) {
                Text("Canal de la interfaz (cada canal guarda su propia configuración)", color = C.dim, fontSize = 12.sp)
                Segmented(listOf("0" to "Canal 1", "1" to "Canal 2", "-1" to "1 + 2"), o.inputChannel.toString(), { vm.updateOptions(o.copy(inputChannel = it.toInt())) })
            }
            DevicePicker("Escucha (salida)", outputs, o.outputId) { vm.updateOptions(o.copy(outputId = it)) }
            Text("Volumen de la escucha: no cambia lo que se graba.", color = C.dim, fontSize = 12.sp)
            Slider(o.monitorVolume, { vm.updateOptions(o.copy(monitorVolume = it)) }, colors = SliderDefaults.colors(thumbColor = C.accent, activeTrackColor = C.accent))
            SettingSwitch("Micrófono sin procesar del teléfono", "Desactiva la supresión de ruido y el control de volumen automáticos del teléfono, para que solo actúe este procesador (recomendado).", o.unprocessed) {
                vm.updateOptions(o.copy(unprocessed = it))
            }
            SettingSwitch("Grabar también sin procesar", "Guarda una copia del micrófono original junto a cada grabación, para reprocesarla después con otro preset.", vm.recordRaw) {
                vm.recordRaw = it
                vm.persistLater()
            }
            Text(
                "Consejo: para escucharte en vivo usa audífonos con cable o USB-C. Los Bluetooth agregan 150–300 ms de retraso. " +
                    "Con una interfaz USB-C (guitarra, micrófono XLR) elige «USB» como micrófono.",
                color = C.dim, fontSize = 12.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text("Gritómetro Procesador de Audio Android ${com.gritometro.procesador.BuildConfig.VERSION_NAME}", color = C.dim, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SettingSwitch(title: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.clickable { onChange(!checked) }) {
        Column(Modifier.weight(1f)) {
            Text(title, color = C.text, fontSize = 14.sp)
            Text(hint, color = C.dim, fontSize = 12.sp)
        }
        Spacer(Modifier.width(8.dp))
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedTrackColor = C.accent))
    }
}

@Composable
private fun DevicePicker(label: String, devices: List<android.media.AudioDeviceInfo>, selected: Int?, onSelect: (Int?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = devices.firstOrNull { it.id == selected }?.let { LiveEngine.deviceName(it) } ?: "Automático (el que use el teléfono)"
    Column {
        Text(label, color = C.dim, fontSize = 12.sp)
        Box {
            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(current, color = C.text, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            DropdownMenu(open, { open = false }) {
                DropdownMenuItem(text = { Text("Automático (el que use el teléfono)") }, onClick = { onSelect(null); open = false })
                devices.forEach { d -> DropdownMenuItem(text = { Text(LiveEngine.deviceName(d)) }, onClick = { onSelect(d.id); open = false }) }
            }
        }
    }
}

@Composable
fun AssistantDialog(vm: MainViewModel) {
    val phase = vm.assistantPhase
    if (phase == AssistantPhase.Idle) return
    val inst = vm.presets.isInstrument(vm.useId)
    AlertDialog(
        onDismissRequest = { if (phase == AssistantPhase.Ready || phase == AssistantPhase.Done) vm.closeAssistant() },
        title = { Text("Asistente automático") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when (phase) {
                    AssistantPhase.Ready -> {
                        if (inst) {
                            Text("Deja el instrumento conectado y con su volumen de siempre. El asistente medirá:")
                            Text("1. 3 segundos sin tocar, con las cuerdas apagadas con la mano.")
                            Text("2. 8 segundos tocando como en el tema: notas sueltas, acordes y algún golpe fuerte.")
                            Text("Ajusta la ganancia, la puerta y los compresores; el EQ del preset no se toca.", color = C.dim, fontSize = 13.sp)
                        } else {
                            Text("Ponte a la distancia de siempre del micrófono. El asistente medirá:")
                            Text("1. 3 segundos de silencio (ruido del lugar).")
                            Text("2. 8 segundos hablando normal, como en una llamada o un audio.")
                            Text("Ajusta la ganancia, la puerta, los compresores, el de-esser y corrige el EQ hacia una voz equilibrada. Mejor partir de un preset de uso.", color = C.dim, fontSize = 13.sp)
                        }
                    }
                    AssistantPhase.Noise -> {
                        Text("Silencio…", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = C.accent)
                        Text("No hables ni toques. Quedan ${vm.assistantLeft} s.")
                    }
                    AssistantPhase.Speech -> {
                        Text(if (inst) "¡Toca!" else "¡Habla normal!", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = C.ok)
                        Text("Quedan ${vm.assistantLeft} s.")
                        LevelBar("IN", vm.meters[com.gritometro.procesador.audio.Native.M_IN_PEAK], vm.meters[com.gritometro.procesador.audio.Native.M_IN_RMS])
                    }
                    AssistantPhase.Done -> {
                        val r = vm.assistantResult
                        r?.notes?.forEach { Text("• $it", fontSize = 14.sp) }
                    }
                    AssistantPhase.Idle -> {}
                }
            }
        },
        confirmButton = {
            when (phase) {
                AssistantPhase.Ready -> TextButton(onClick = { vm.startAssistant() }) { Text("Empezar") }
                AssistantPhase.Done -> if (vm.assistantResult?.applied == true) TextButton(onClick = { vm.applyAssistant() }) { Text("Aplicar") } else TextButton(onClick = { vm.startAssistant() }) { Text("Repetir") }
                else -> {}
            }
        },
        dismissButton = { TextButton(onClick = { vm.closeAssistant() }) { Text("Cancelar") } },
    )
}
