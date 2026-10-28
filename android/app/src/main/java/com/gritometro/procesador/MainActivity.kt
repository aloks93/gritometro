package com.gritometro.procesador

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AudioFile
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.gritometro.procesador.ui.AssistantDialog
import com.gritometro.procesador.ui.C
import com.gritometro.procesador.ui.FileScreen
import com.gritometro.procesador.ui.LiveScreen
import com.gritometro.procesador.ui.PresetSheet
import com.gritometro.procesador.ui.ProcTheme
import com.gritometro.procesador.ui.RecordingsScreen
import com.gritometro.procesador.ui.SettingsSheet
import com.gritometro.procesador.ui.TunerScreen

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val perms = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (perms.isNotEmpty()) requestPermissions(perms.toTypedArray(), 1)
        handleIntent(intent)
        setContent { ProcTheme { App(vm) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** An audio shared from another app (or opened with this one) goes to the Archivo tab */
    private fun handleIntent(intent: Intent?) {
        val uri: Uri? = when (intent?.action) {
            Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            Intent.ACTION_VIEW -> intent.data
            else -> null
        }
        if (uri != null) {
            vm.openFile(uri)
            intent?.action = null
        }
    }

    override fun onStop() {
        vm.saveNow()
        super.onStop()
    }
}

@Composable
private fun App(vm: MainViewModel) {
    val snack = remember { SnackbarHostState() }
    var presetsOpen by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    val context = androidx.compose.ui.platform.LocalContext.current

    val openAudio = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { vm.openFile(it) } }
    val importPreset = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { vm.importPreset(it) } }
    val exportPreset = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let { vm.writePreset(it) } }

    LaunchedEffect(vm.message) {
        vm.message?.let {
            snack.showSnackbar(it)
            vm.message = null
        }
    }

    Scaffold(
        containerColor = C.bg,
        snackbarHost = { SnackbarHost(snack) },
        bottomBar = {
            NavigationBar(containerColor = C.panel) {
                Tab.entries.forEach { t ->
                    val icon = when (t) {
                        Tab.Live -> Icons.Default.Mic
                        Tab.File -> Icons.Default.AudioFile
                        Tab.Tuner -> Icons.Default.GraphicEq
                        Tab.Recordings -> Icons.Default.LibraryMusic
                    }
                    NavigationBarItem(
                        selected = vm.tab == t,
                        onClick = {
                            vm.tab = t
                            if (t == Tab.Recordings) vm.refreshRecordings()
                        },
                        icon = { Icon(icon, t.label) },
                        label = { Text(t.label) },
                        colors = NavigationBarItemDefaults.colors(selectedIconColor = C.accent, selectedTextColor = C.accent, indicatorColor = C.accent.copy(alpha = 0.15f), unselectedIconColor = C.dim, unselectedTextColor = C.dim),
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (vm.tab) {
                Tab.Live -> LiveScreen(vm, { presetsOpen = true }, { settingsOpen = true })
                Tab.File -> FileScreen(vm, { openAudio.launch(arrayOf("audio/*", "video/*")) }, { presetsOpen = true })
                Tab.Tuner -> TunerScreen(vm)
                Tab.Recordings -> RecordingsScreen(vm) { f -> context.startActivity(Intent.createChooser(vm.shareIntent(f), "Compartir")) }
            }
        }
    }
    if (presetsOpen) PresetSheet(vm, { presetsOpen = false }, { importPreset.launch(arrayOf("application/json", "*/*")) }, {
        exportPreset.launch("${vm.presetLabel.ifBlank { "preset" }.replace(Regex("[\\\\/:*?\"<>|]"), "_")}.json")
    })
    if (settingsOpen) SettingsSheet(vm) { settingsOpen = false }
    AssistantDialog(vm)
}
