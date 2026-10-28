package com.gritometro.procesador.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gritometro.procesador.MainViewModel
import com.gritometro.procesador.Recording
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun RecordingsScreen(vm: MainViewModel, onShare: (File) -> Unit) {
    var renaming by remember { mutableStateOf<File?>(null) }
    var deleting by remember { mutableStateOf<File?>(null) }
    if (vm.recordings.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("Aún no hay grabaciones. Graba en «En vivo» o exporta un audio desde «Archivo».", color = C.dim, fontSize = 14.sp)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(vm.recordings, key = { it.file.path }) { r -> RecordingRow(vm, r, onShare, { renaming = r.file }, { deleting = r.file }) }
    }
    renaming?.let { f ->
        var name by remember(f) { mutableStateOf(f.nameWithoutExtension) }
        AlertDialog(
            onDismissRequest = { renaming = null },
            title = { Text("Renombrar") },
            text = { OutlinedTextField(name, { name = it }, singleLine = true) },
            confirmButton = { TextButton(onClick = { vm.renameRecording(f, name); renaming = null }) { Text("Guardar") } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancelar") } },
        )
    }
    deleting?.let { f ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("¿Borrar la grabación?") },
            text = { Text(f.nameWithoutExtension) },
            confirmButton = { TextButton(onClick = { vm.deleteRecording(f); deleting = null }) { Text("Borrar", color = C.bad) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancelar") } },
        )
    }
}

@Composable
private fun RecordingRow(vm: MainViewModel, r: Recording, onShare: (File) -> Unit, onRename: () -> Unit, onDelete: () -> Unit) {
    val playing = vm.playingRecording == r.file
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.playRecording(r.file) }) {
                Icon(if (playing) Icons.Default.Stop else Icons.Default.PlayArrow, if (playing) "Detener" else "Escuchar", tint = C.accent)
            }
            Column(Modifier.weight(1f)) {
                Text(r.name, color = C.text, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val kb = r.file.length() / 1024
                val size = if (kb > 1024) String.format(Locale.US, "%.1f MB", kb / 1024f) else "$kb KB"
                Text(
                    "${r.file.extension.uppercase()} · $size · ${SimpleDateFormat("d MMM HH:mm", Locale("es")).format(Date(r.file.lastModified()))}",
                    color = C.dim, fontSize = 12.sp,
                )
            }
            IconButton(onClick = { onShare(r.file) }) { Icon(Icons.Default.Share, "Compartir", tint = C.text) }
            var menu by remember { mutableStateOf(false) }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Más", tint = C.text) }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("Procesar (abrir en Archivo)") }, onClick = { menu = false; vm.processRecording(r.file) })
                    DropdownMenuItem(text = { Text("Guardar en Música") }, onClick = { menu = false; vm.saveToMusic(r.file) })
                    DropdownMenuItem(text = { Text("Renombrar") }, onClick = { menu = false; onRename() })
                    DropdownMenuItem(text = { Text("Borrar", color = C.bad) }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
    Box(Modifier.fillMaxWidth())
}
