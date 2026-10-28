package com.gritometro.procesador

import android.app.Application
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.gritometro.procesador.audio.AudioHub
import com.gritometro.procesador.audio.CancelledException
import com.gritometro.procesador.audio.Decoded
import com.gritometro.procesador.audio.FileEngine
import com.gritometro.procesador.audio.FilePlayer
import com.gritometro.procesador.audio.LiveEngine
import com.gritometro.procesador.audio.Native
import com.gritometro.procesador.audio.ProcessorSettings
import com.gritometro.procesador.model.AutoSetupResult
import com.gritometro.procesador.model.Chain
import com.gritometro.procesador.model.PitchSmoother
import com.gritometro.procesador.model.PresetFiles
import com.gritometro.procesador.model.Presets
import com.gritometro.procesador.model.TUNINGS
import com.gritometro.procesador.model.VOICE_REGIONS
import com.gritometro.procesador.model.VoiceMeasurement
import com.gritometro.procesador.model.autoSetup
import com.gritometro.procesador.model.tunerMinHz
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.log10
import kotlin.math.pow

enum class Tab(val label: String) { Live("En vivo"), File("Archivo"), Tuner("Afinador"), Recordings("Grabaciones") }

enum class Module(val label: String) {
    Gain("Ganancia"), Noise("Ruido"), Gate("Puerta"), Eq("EQ"), DeEsser("De-esser"),
    Comp1("Comp 1"), Comp2("Comp 2"), Saturation("Saturador"), Limiter("Limitador");

    /** JSON key of the module's "on" switch (null = always on) */
    val key: String?
        get() = when (this) {
            Gain -> null
            Noise -> "noise"
            Gate -> "gate"
            Eq -> "eq"
            DeEsser -> "deesser"
            Comp1 -> "comp1"
            Comp2 -> "comp2"
            Saturation -> "saturation"
            Limiter -> "limiter"
        }
}

enum class AssistantPhase { Idle, Ready, Noise, Speech, Done }

data class UserPreset(val name: String, val chain: String)

data class Recording(val file: File, val raw: Boolean) {
    val name: String get() = file.nameWithoutExtension
}

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val ctx: Context get() = getApplication()
    private val prefs = app.getSharedPreferences("state", Context.MODE_PRIVATE)
    val presets = Presets.load(app)
    val live: LiveEngine get() = AudioHub.live

    // ---- Processor state (shared by live and file)
    var chain by mutableStateOf(Chain(Native.normalizeChain(presets.chain("speech", "lavalier") ?: "{}")))
        private set
    var inputGainDb by mutableStateOf(0f)
        private set
    var outputGainDb by mutableStateOf(0f)
        private set
    var useId by mutableStateOf("speech")
        private set
    var micId by mutableStateOf("lavalier")
        private set
    /** What is loaded: "Voz hablada · Dinámico" or a user preset's name; "(modificado)" after edits */
    var presetLabel by mutableStateOf("")
        private set
    var modified by mutableStateOf(false)
        private set
    val userPresets = mutableStateListOf<UserPreset>()

    var tab by mutableStateOf(Tab.Live)
    var module by mutableStateOf(Module.Eq)
    var selectedBand by mutableStateOf(2)
    var message by mutableStateOf<String?>(null)

    // ---- Live
    var liveOn by mutableStateOf(false)
        private set
    var abHeld by mutableStateOf(false)
        private set
    var options by mutableStateOf(LiveEngine.Options())
        private set
    var recordRaw by mutableStateOf(false)
    var recordingSeconds by mutableStateOf<Float?>(null)
        private set
    var howl by mutableStateOf(false)
        private set
    var outputWarning by mutableStateOf<String?>(null)
        private set

    // ---- Meters (whichever engine is active), refreshed ~30 times a second
    var meters by mutableStateOf(FloatArray(Native.METERS) { if (it < 4 || it == Native.M_LUFS_M || it == Native.M_LUFS_S || it == Native.M_TRUE_PEAK) -100f else 0f })
        private set
    var spectrumIn by mutableStateOf(FloatArray(0))
        private set
    var spectrumOut by mutableStateOf(FloatArray(0))
        private set
    var meterRate by mutableStateOf(48000)
        private set

    // ---- File
    var decoded by mutableStateOf<Decoded?>(null)
        private set
    var loadingProgress by mutableStateOf<Float?>(null)
        private set
    var player: FilePlayer? = null
        private set
    var filePlaying by mutableStateOf(false)
        private set
    var filePosition by mutableStateOf(0L)
        private set
    var fileBypass by mutableStateOf(false)
        private set
    var exportProgress by mutableStateOf<Float?>(null)
        private set
    var exportM4a by mutableStateOf(false)
    /** null = no normalization */
    var exportTarget by mutableStateOf<Float?>(-16f)
    private var fileJob: Job? = null
    @Volatile private var cancelFile = false

    // ---- Recordings
    val recordings = mutableStateListOf<Recording>()
    var playingRecording by mutableStateOf<File?>(null)
        private set
    private var mediaPlayer: MediaPlayer? = null

    // ---- Tuner
    var tuningId by mutableStateOf("chromatic")
    var a4 by mutableStateOf(440f)
    var pitchHz by mutableStateOf<Float?>(null)
        private set
    private val smoother = PitchSmoother()

    // ---- Assistant
    var assistantPhase by mutableStateOf(AssistantPhase.Idle)
        private set
    var assistantLeft by mutableStateOf(0)
        private set
    var assistantResult by mutableStateOf<AutoSetupResult?>(null)
        private set
    private var asT0 = 0L
    private var asNoiseSum = 0.0
    private var asNoiseN = 0
    private var asPeak = -100f
    private var asSpeechSum = 0.0
    private var asSpeechN = 0
    private val asRegions = mutableMapOf<String, Double>()
    private var asRegionN = 0
    private var startedLiveForAssistant = false

    // ---- Per-channel setups: device + channel → { chain, gains }
    private val channelSetups = JSONObject()

    private var saveJob: Job? = null

    init {
        AudioHub.init(app)
        load()
        refreshRecordings()
        pushSettings()
        AudioHub.onStopped = { liveOn = false; recordingSeconds = null }
        liveOn = live.running
        viewModelScope.launch { ticker() }
    }

    // ---------------------------------------------------------------- settings → engines

    private fun settingsFor(bypass: Boolean) = ProcessorSettings(chain.json, inputGainDb, outputGainDb, bypass)

    private fun pushSettings() {
        live.setSettings(settingsFor(abHeld))
        player?.setSettings(settingsFor(fileBypass))
    }

    private fun changed(markModified: Boolean = true) {
        if (markModified) modified = true
        pushSettings()
        scheduleSave()
    }

    fun set(path: String, value: Any?) {
        chain = chain.with(path, value)
        changed()
    }

    /** A whole new chain at once (EQ point drags change several fields together) */
    fun replaceChain(c: Chain) {
        chain = c
        changed()
    }

    fun setInputGain(db: Float) {
        inputGainDb = db
        changed()
    }

    fun setOutputGain(db: Float) {
        outputGainDb = db
        changed()
    }

    fun toggleModule(m: Module) {
        val k = m.key ?: return
        set("$k.on", !chain.bool("$k.on"))
    }

    // ---------------------------------------------------------------- presets

    fun presetName(useId: String, micId: String): String =
        "${presets.use(useId)?.name ?: useId} · ${presets.mic(micId)?.name ?: micId}"

    fun applyPreset(useId: String, micId: String) {
        val c = presets.chain(useId, micId) ?: return
        // A learned noise profile belongs to the room, not to the preset: keep it
        val profile = chain.profile()
        var next = Chain(Native.normalizeChain(c))
        if (profile != null) next = next.with("noise.profile", profile)
        chain = next
        this.useId = useId
        this.micId = micId
        presetLabel = presetName(useId, micId)
        modified = false
        changed(false)
    }

    fun selectUse(id: String) = applyPreset(id, presets.micFor(id, micId))

    fun saveUserPreset(name: String) {
        val n = name.trim().ifBlank { "Preset ${userPresets.size + 1}" }
        val i = userPresets.indexOfFirst { it.name.equals(n, ignoreCase = true) }
        val p = UserPreset(n, chain.json)
        if (i >= 0) userPresets[i] = p else userPresets.add(p)
        presetLabel = n
        modified = false
        scheduleSave()
        message = "Preset «$n» guardado."
    }

    fun loadUserPreset(p: UserPreset) {
        chain = Chain(Native.normalizeChain(p.chain))
        presetLabel = p.name
        modified = false
        changed(false)
    }

    fun deleteUserPreset(p: UserPreset) {
        userPresets.remove(p)
        scheduleSave()
    }

    fun exportPresetText(): String = PresetFiles.serialize(presetLabel.ifBlank { "Mi preset" }, chain.json)

    fun importPreset(uri: Uri) {
        try {
            val text = ctx.contentResolver.openInputStream(uri)!!.bufferedReader().use { it.readText() }
            val (name, c) = PresetFiles.parse(text)
            chain = Chain(Native.normalizeChain(c))
            presetLabel = name
            modified = false
            changed(false)
            message = "Preset «$name» cargado."
        } catch (e: Exception) {
            message = e.message ?: "No se pudo leer el preset."
        }
    }

    fun writePreset(uri: Uri) {
        runCatching {
            ctx.contentResolver.openOutputStream(uri)!!.bufferedWriter().use { it.write(exportPresetText()) }
            message = "Preset exportado."
        }.onFailure { message = "No se pudo guardar el preset." }
    }

    // ---------------------------------------------------------------- live

    fun toggleLive() {
        if (liveOn) stopLive() else startLive()
    }

    fun startLive(): Boolean {
        stopFilePlayback()
        if (!AudioHub.startLive()) {
            message = live.error ?: "No se pudo abrir el micrófono."
            return false
        }
        liveOn = true
        meterRate = live.sampleRate
        return true
    }

    fun stopLive() {
        if (recordingSeconds != null) stopRecording()
        AudioHub.stopLive()
        liveOn = false
    }

    fun setAb(held: Boolean) {
        abHeld = held
        live.setSettings(settingsFor(held))
    }

    fun updateOptions(o: LiveEngine.Options) {
        val old = options
        // Each device channel keeps its own setup, as the PC's Canales tab
        if (o.inputId != old.inputId || o.inputChannel != old.inputChannel) {
            storeChannelSetup(old)
            restoreChannelSetup(o)
        }
        options = o
        live.setOptions(o)
        if (o.monitor) howl = false
        scheduleSave()
    }

    private fun channelKey(o: LiveEngine.Options): String {
        val dev = o.inputId?.let { id -> live.inputs().firstOrNull { it.id == id } }
        return (dev?.let { LiveEngine.deviceName(it) } ?: "default") + "|" + o.inputChannel
    }

    private fun storeChannelSetup(o: LiveEngine.Options) {
        channelSetups.put(channelKey(o), JSONObject().put("chain", chain.json).put("in", inputGainDb.toDouble()).put("out", outputGainDb.toDouble()).put("label", presetLabel))
    }

    private fun restoreChannelSetup(o: LiveEngine.Options) {
        val s = channelSetups.optJSONObject(channelKey(o)) ?: return
        chain = Chain(Native.normalizeChain(s.getString("chain")))
        inputGainDb = s.optDouble("in", 0.0).toFloat()
        outputGainDb = s.optDouble("out", 0.0).toFloat()
        presetLabel = s.optString("label", presetLabel)
        changed(false)
        message = "Configuración de este canal cargada."
    }

    fun recordingsDir(): File = (ctx.getExternalFilesDir("Grabaciones") ?: File(ctx.filesDir, "Grabaciones")).apply { mkdirs() }

    private fun stamp(): String = SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.US).format(Date())

    fun toggleRecording() {
        if (recordingSeconds != null) stopRecording() else startRecording()
    }

    private fun startRecording() {
        if (!liveOn && !startLive()) return
        val base = "Grabación ${stamp()}"
        val dir = recordingsDir()
        live.startRecording(File(dir, "$base.wav"), if (recordRaw) File(dir, "$base (sin procesar).wav") else null)
        recordingSeconds = 0f
        AudioHub.refreshNotification()
    }

    private fun stopRecording() {
        val f = live.stopRecording()
        recordingSeconds = null
        refreshRecordings()
        AudioHub.refreshNotification()
        if (f != null) message = "Grabación guardada: ${f.nameWithoutExtension}"
    }

    fun learnNoise() {
        if (!liveOn && !startLive()) return
        Native.learnNoise(live.handle, 2f)
        message = "Silencio 2 segundos: aprendiendo el ruido…"
    }

    // ---------------------------------------------------------------- assistant

    fun openAssistant() {
        assistantResult = null
        assistantPhase = AssistantPhase.Ready
    }

    fun closeAssistant() {
        assistantPhase = AssistantPhase.Idle
        if (startedLiveForAssistant) {
            startedLiveForAssistant = false
            stopLive()
        }
    }

    fun startAssistant() {
        if (!liveOn) {
            if (!startLive()) return
            startedLiveForAssistant = true
        }
        asNoiseSum = 0.0; asNoiseN = 0; asPeak = -100f; asSpeechSum = 0.0; asSpeechN = 0
        asRegions.clear(); asRegionN = 0
        asT0 = System.currentTimeMillis()
        assistantPhase = AssistantPhase.Noise
    }

    fun applyAssistant() {
        val r = assistantResult ?: return
        if (r.applied) {
            chain = r.chain
            inputGainDb = r.inputGainDb
            changed()
        }
        closeAssistant()
    }

    private fun assistantStep(m: FloatArray) {
        val el = (System.currentTimeMillis() - asT0) / 1000f
        if (assistantPhase == AssistantPhase.Noise) {
            asNoiseSum += 10.0.pow(m[Native.M_IN_RMS] / 10.0)
            asNoiseN++
            assistantLeft = kotlin.math.ceil(3 - el).toInt()
            if (el >= 3) {
                assistantPhase = AssistantPhase.Speech
                asT0 = System.currentTimeMillis()
            }
            return
        }
        val noiseDb = (10 * log10(asNoiseSum / maxOf(1, asNoiseN))).toFloat()
        asPeak = maxOf(asPeak, m[Native.M_IN_PEAK])
        if (m[Native.M_IN_RMS] > noiseDb + 10) {
            asSpeechSum += 10.0.pow(m[Native.M_IN_RMS] / 10.0)
            asSpeechN++
            val spec = spectrumIn
            if (spec.isNotEmpty()) {
                val binHz = meterRate.toFloat() / Native.FFT
                for ((k, range) in VOICE_REGIONS) {
                    var s = 0.0
                    var n = 0
                    var b = kotlin.math.ceil(range.first / binHz).toInt()
                    while (b <= (range.second / binHz).toInt() && b < spec.size) {
                        s += spec[b]; n++; b++
                    }
                    asRegions[k] = (asRegions[k] ?: 0.0) + if (n > 0) s / n else -140.0
                }
                asRegionN++
            }
        }
        assistantLeft = kotlin.math.ceil(8 - el).toInt()
        if (el >= 8) {
            val meas = VoiceMeasurement(
                noiseDb = noiseDb,
                peakDb = asPeak,
                speechDb = if (asSpeechN > 0) (10 * log10(asSpeechSum / asSpeechN)).toFloat() else -100f,
                regions = if (asRegionN > 5) asRegions.mapValues { (it.value / asRegionN).toFloat() } else null,
            )
            assistantResult = autoSetup(chain, inputGainDb, presets.isInstrument(useId), meas)
            assistantPhase = AssistantPhase.Done
        }
    }

    // ---------------------------------------------------------------- file

    fun openFile(uri: Uri) {
        tab = Tab.File
        closeFile()
        cancelFile = false
        loadingProgress = 0f
        fileJob = viewModelScope.launch {
            try {
                val d = withContext(Dispatchers.IO) {
                    // Some apps grant access only for the moment: copy-free decode right away
                    FileEngine.decode(ctx, uri, File(ctx.cacheDir, "decoded.f32"), { p -> loadingProgress = p }, { cancelFile })
                }
                decoded = d
                filePosition = 0
                player = FilePlayer(d).also { it.setSettings(settingsFor(fileBypass)) }
            } catch (e: CancelledException) {
                // closed while loading
            } catch (e: Exception) {
                message = e.message ?: "No se pudo abrir el archivo."
            } finally {
                loadingProgress = null
            }
        }
    }

    fun closeFile() {
        cancelFile = true
        player?.release()
        player = null
        decoded = null
        filePlaying = false
        filePosition = 0
    }

    fun toggleFilePlay() {
        val p = player ?: return
        if (p.playing) p.pause() else {
            if (liveOn) stopLive()
            p.play()
            meterRate = decoded?.sampleRate ?: 48000
        }
        filePlaying = p.playing
    }

    private fun stopFilePlayback() {
        player?.pause()
        filePlaying = false
    }

    fun seekFile(fraction: Float) {
        val d = decoded ?: return
        player?.seek((fraction * d.frames).toLong())
        filePosition = (fraction * d.frames).toLong()
    }

    fun setFileAb(held: Boolean) {
        fileBypass = held
        player?.setSettings(settingsFor(held))
    }

    fun exportFile() {
        val d = decoded ?: return
        if (exportProgress != null) return
        cancelFile = false
        exportProgress = 0f
        val m4a = exportM4a
        val base = d.name.substringBeforeLast('.').take(60)
        val dest = File(recordingsDir(), "$base (procesado ${stamp()}).${if (m4a) "m4a" else "wav"}")
        val s = settingsFor(false)
        val ceiling = if (chain.bool("limiter.on")) chain.num("limiter.ceilingDb", -1f) else -1f
        fileJob = viewModelScope.launch {
            try {
                val r = withContext(Dispatchers.Default) {
                    FileEngine.export(d, s, dest, m4a, exportTarget, ceiling, { exportProgress = it }, { cancelFile })
                }
                refreshRecordings()
                message = "Exportado: ${r.file.nameWithoutExtension} · %.1f LUFS · pico %.1f dBTP".format(Locale.US, r.lufs, r.truePeak)
            } catch (e: CancelledException) {
                message = "Exportación cancelada."
            } catch (e: Exception) {
                message = "No se pudo exportar: ${e.message}"
            } finally {
                exportProgress = null
            }
        }
    }

    fun cancelExport() {
        cancelFile = true
    }

    // ---------------------------------------------------------------- recordings

    fun refreshRecordings() {
        val files = recordingsDir().listFiles()?.filter { it.isFile && (it.extension == "wav" || it.extension == "m4a") } ?: emptyList()
        recordings.clear()
        recordings.addAll(files.sortedByDescending { it.lastModified() }.map { Recording(it, it.name.contains("(sin procesar)")) })
    }

    fun playRecording(f: File) {
        mediaPlayer?.release()
        mediaPlayer = null
        if (playingRecording == f) {
            playingRecording = null
            return
        }
        if (liveOn) stopLive()
        stopFilePlayback()
        mediaPlayer = MediaPlayer().apply {
            setDataSource(f.path)
            setOnCompletionListener { playingRecording = null }
            prepare()
            start()
        }
        playingRecording = f
    }

    fun deleteRecording(f: File) {
        if (playingRecording == f) playRecording(f)
        f.delete()
        refreshRecordings()
    }

    fun renameRecording(f: File, name: String) {
        val clean = name.trim().replace(Regex("[\\\\/:*?\"<>|]"), "_")
        if (clean.isBlank()) return
        val dest = File(f.parentFile, "$clean.${f.extension}")
        if (dest.exists()) {
            message = "Ya existe una grabación con ese nombre."
            return
        }
        f.renameTo(dest)
        refreshRecordings()
    }

    fun shareIntent(f: File): Intent {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", f)
        return Intent(Intent.ACTION_SEND).apply {
            type = if (f.extension == "m4a") "audio/mp4" else "audio/wav"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /** Copies a recording to Música/Gritometro, where any player or file manager finds it */
    fun saveToMusic(f: File) {
        if (Build.VERSION.SDK_INT < 29) {
            message = "En esta versión de Android usa «Compartir» para guardarla."
            return
        }
        runCatching {
            val values = ContentValues().apply {
                put(MediaStore.Audio.Media.DISPLAY_NAME, f.name)
                put(MediaStore.Audio.Media.MIME_TYPE, if (f.extension == "m4a") "audio/mp4" else "audio/wav")
                put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/Gritometro")
            }
            val uri = ctx.contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)!!
            ctx.contentResolver.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out) } }
            message = "Guardada en Música/Gritometro."
        }.onFailure { message = "No se pudo guardar en Música: ${it.message}" }
    }

    fun processRecording(f: File) = openFile(Uri.fromFile(f))

    // ---------------------------------------------------------------- meters loop

    private suspend fun ticker() {
        val m = FloatArray(Native.METERS)
        var frame = 0
        while (currentCoroutineContextActive()) {
            delay(33)
            frame++
            val p = player
            val h = when {
                p != null && p.playing -> p.handle
                live.running -> live.handle
                else -> 0L
            }
            if (p != null) {
                val pos = p.position
                if (pos != filePosition) filePosition = pos
                if (filePlaying != p.playing) filePlaying = p.playing
            }
            if (liveOn && !live.running) {
                // The audio thread stopped by itself (mic lost, permission revoked…)
                liveOn = false
                recordingSeconds = null
                live.error?.let { message = it }
                AudioHub.stopLive()
            }
            if (recordingSeconds != null) recordingSeconds = live.recordingFrames / live.sampleRate.toFloat()
            if (live.howlMuted != howl) {
                howl = live.howlMuted
                if (howl) message = "Se detectó acople (pitido): se silenció la escucha. Aleja el micrófono del altavoz."
            }
            if (h == 0L) continue
            Native.meters(h, m)
            meters = m.copyOf()
            val needSpectrum = (tab == Tab.Live || tab == Tab.File) && module == Module.Eq || assistantPhase == AssistantPhase.Speech
            if (needSpectrum && frame % 2 == 0) {
                val si = FloatArray(Native.FFT / 2)
                val so = FloatArray(Native.FFT / 2)
                withContext(Dispatchers.Default) {
                    Native.spectrum(h, false, si)
                    Native.spectrum(h, true, so)
                }
                spectrumIn = si
                spectrumOut = so
            }
            if (assistantPhase == AssistantPhase.Noise || assistantPhase == AssistantPhase.Speech) assistantStep(m)
            if (tab == Tab.Tuner && frame % 3 == 0 && h == live.handle) {
                val tuning = TUNINGS.firstOrNull { it.id == tuningId } ?: TUNINGS[0]
                val r = withContext(Dispatchers.Default) { Native.pitch(h, tunerMinHz(tuning, a4), 1500f) }
                if (r != null && r[1] > 0.8f) {
                    pitchHz = smoother.push(r[0])
                } else if (m[Native.M_IN_PEAK] < -60) {
                    // Silence: the needle goes away until the next note
                    smoother.reset()
                    pitchHz = null
                }
            }
            // A finished "Aprender ruido" becomes the chain's profile (learned mode)
            if (m[Native.M_LEARNING] == 0f) {
                Native.takeLearnedProfile(h)?.let { profile ->
                    chain = chain.withAll("noise.profile" to profile, "noise.mode" to "learned", "noise.on" to true)
                    changed()
                    message = "Ruido aprendido: reducción en modo «Aprendido»."
                }
            }
            if (live.running) outputWarning = outputWarningText()
        }
    }

    private suspend fun currentCoroutineContextActive(): Boolean = kotlin.coroutines.coroutineContext.isActive

    private fun outputWarningText(): String? {
        val out = live.currentOutput()
        if (!options.monitor) return null
        return when {
            LiveEngine.isBluetooth(out) -> "Audífonos Bluetooth: te oirás con retraso. Para escucharte en vivo usa audífonos con cable o USB-C."
            LiveEngine.isSpeaker(out) -> "La escucha sale por el altavoz: conecta audífonos o se acoplará (pitido)."
            else -> null
        }
    }

    // ---------------------------------------------------------------- persistence

    private fun scheduleSave() {
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            delay(400)
            save()
        }
    }

    private fun save() {
        val presetsArr = JSONArray()
        userPresets.forEach { presetsArr.put(JSONObject().put("name", it.name).put("chain", JSONObject(it.chain))) }
        val o = options
        prefs.edit()
            .putString("chain", chain.json)
            .putFloat("inputGain", inputGainDb)
            .putFloat("outputGain", outputGainDb)
            .putString("useId", useId)
            .putString("micId", micId)
            .putString("presetLabel", presetLabel)
            .putBoolean("modified", modified)
            .putString("userPresets", presetsArr.toString())
            .putBoolean("monitor", o.monitor)
            .putFloat("monitorVolume", o.monitorVolume)
            .putBoolean("unprocessed", o.unprocessed)
            .putInt("inputChannel", o.inputChannel)
            .putBoolean("recordRaw", recordRaw)
            .putString("tuningId", tuningId)
            .putFloat("a4", a4)
            .putBoolean("exportM4a", exportM4a)
            .putFloat("exportTarget", exportTarget ?: 0f)
            .putString("channelSetups", channelSetups.toString())
            .apply()
    }

    fun saveNow() = save()

    private fun load() {
        prefs.getString("chain", null)?.let { chain = Chain(Native.normalizeChain(it)) }
        inputGainDb = prefs.getFloat("inputGain", 0f)
        outputGainDb = prefs.getFloat("outputGain", 0f)
        useId = prefs.getString("useId", "speech")!!
        micId = prefs.getString("micId", "lavalier")!!
        presetLabel = prefs.getString("presetLabel", null) ?: presetName(useId, micId)
        modified = prefs.getBoolean("modified", false)
        runCatching {
            val a = JSONArray(prefs.getString("userPresets", "[]"))
            for (i in 0 until a.length()) a.getJSONObject(i).let { userPresets.add(UserPreset(it.getString("name"), it.getJSONObject("chain").toString())) }
        }
        options = LiveEngine.Options(
            monitor = prefs.getBoolean("monitor", true),
            monitorVolume = prefs.getFloat("monitorVolume", 0.8f),
            unprocessed = prefs.getBoolean("unprocessed", true),
            inputChannel = prefs.getInt("inputChannel", 0),
        )
        live.setOptions(options)
        recordRaw = prefs.getBoolean("recordRaw", false)
        tuningId = prefs.getString("tuningId", "chromatic")!!
        a4 = prefs.getFloat("a4", 440f)
        exportM4a = prefs.getBoolean("exportM4a", false)
        exportTarget = prefs.getFloat("exportTarget", -16f).takeIf { it != 0f }
        runCatching {
            val s = JSONObject(prefs.getString("channelSetups", "{}")!!)
            s.keys().forEach { channelSetups.put(it, s.get(it)) }
        }
    }

    fun persistLater() = scheduleSave()

    override fun onCleared() {
        save()
        closeFile()
        mediaPlayer?.release()
        super.onCleared()
    }
}
