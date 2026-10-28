package com.gritometro.procesador.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.MainViewModel

@Composable
fun FileScreen(vm: MainViewModel, onOpen: () -> Unit, onPresets: () -> Unit) {
    val d = vm.decoded
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PresetHeader(vm, onPresets, null)
        val loading = vm.loadingProgress
        if (loading != null) {
            Panel {
                Text("Abriendo el audio…", color = C.text)
                LinearProgressIndicator(progress = { loading }, modifier = Modifier.fillMaxWidth(), color = C.accent)
            }
            return@Column
        }
        if (d == null) {
            Panel {
                Text("Procesar un audio guardado", color = C.text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "Abre una nota de voz de WhatsApp, una grabación, un MP3, M4A, WAV, OGG/Opus, FLAC o incluso un video. " +
                        "Escúchalo con el procesador, compara con A/B y expórtalo. El original nunca se modifica.",
                    color = C.dim, fontSize = 13.sp,
                )
                Text("También puedes usar «Compartir» desde WhatsApp u otra app y elegir Procesador de Audio.", color = C.dim, fontSize = 13.sp)
                Button(onClick = onOpen, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.FolderOpen, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Abrir audio")
                }
            }
            return@Column
        }
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name, color = C.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${formatTime(d.seconds)} · ${d.sampleRate} Hz · ${if (d.channels == 2) "estéreo" else "mono"}", color = C.dim, fontSize = 12.sp)
                }
                IconButton(onClick = onOpen) { Icon(Icons.Default.FolderOpen, "Abrir otro", tint = C.text) }
                IconButton(onClick = { vm.closeFile() }) { Icon(Icons.Default.Close, "Cerrar", tint = C.text) }
            }
            var dragging by remember { mutableStateOf<Float?>(null) }
            val frac = dragging ?: (vm.filePosition.toFloat() / d.frames).coerceIn(0f, 1f)
            Slider(
                value = frac,
                onValueChange = { dragging = it },
                onValueChangeFinished = { dragging?.let { vm.seekFile(it) }; dragging = null },
                colors = SliderDefaults.colors(thumbColor = C.accent, activeTrackColor = C.accent),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${formatTime(frac * d.seconds)} / ${formatTime(d.seconds)}", color = C.dim, fontFamily = Mono, fontSize = 12.sp, modifier = Modifier.weight(1f))
                HoldButton("original", { vm.setFileAb(it) }, active = vm.fileBypass)
                Spacer(Modifier.width(12.dp))
                RoundAction(if (vm.filePlaying) Icons.Default.Pause else Icons.Default.PlayArrow, if (vm.filePlaying) "Pausa" else "Escuchar", C.accent, vm.filePlaying, { vm.toggleFilePlay() })
            }
        }
        MetersPanel(vm)
        ChainEditor(vm, vm.presets.isInstrument(vm.useId))
        Panel {
            Text("Exportar", color = C.text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Segmented(listOf("wav" to "WAV (máxima calidad)", "m4a" to "M4A (liviano)"), if (vm.exportM4a) "m4a" else "wav", {
                vm.exportM4a = it == "m4a"
                vm.persistLater()
            })
            Text("Volumen final", color = C.dim, fontSize = 12.sp)
            Segmented(
                listOf("off" to "Sin cambio", "-14" to "Redes −14", "-16" to "Voz −16", "-23" to "TV −23"),
                vm.exportTarget?.let { "%.0f".format(it) } ?: "off",
                {
                    vm.exportTarget = it.toFloatOrNull()
                    vm.persistLater()
                },
            )
            Text("Ajusta el volumen al nivel elegido (LUFS) sin pasar el techo del limitador.", color = C.dim, fontSize = 12.sp)
            val p = vm.exportProgress
            if (p != null) {
                LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth(), color = C.accent)
                OutlinedButton(onClick = { vm.cancelExport() }) { Text("Cancelar") }
            } else {
                Button(onClick = { vm.exportFile() }, modifier = Modifier.fillMaxWidth()) { Text("Exportar procesado") }
                Text("Queda en Grabaciones, desde donde puedes compartirlo o guardarlo en Música.", color = C.dim, fontSize = 12.sp)
            }
        }
        Spacer(Modifier.height(8.dp).size(1.dp))
    }
}
