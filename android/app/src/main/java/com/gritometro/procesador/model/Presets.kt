package com.gritometro.procesador.model

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** The built-in presets (use × mic), from the plugin's presets.json (generated from the PC app) */
class Presets(json: String) {
    data class Use(val id: String, val name: String, val hint: String, val group: String, val defaultMic: String, val mics: List<String>)
    data class Mic(val id: String, val name: String, val hint: String, val group: String)

    val groups: List<Pair<String, String>>
    val micGroups: List<Pair<String, String>>
    val uses: List<Use>
    val mics: List<Mic>
    private val chains: JSONObject

    init {
        val o = JSONObject(json)
        fun pairs(a: JSONArray) = (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getString(0) to p.getString(1) } }
        groups = pairs(o.getJSONArray("groups"))
        micGroups = pairs(o.getJSONArray("micGroups"))
        uses = o.getJSONArray("uses").let { a ->
            (0 until a.length()).map { i ->
                val u = a.getJSONObject(i)
                val m = u.getJSONArray("mics")
                Use(u.getString("id"), u.getString("name"), u.getString("hint"), u.getString("group"), u.getString("defaultMic"), (0 until m.length()).map { m.getString(it) })
            }
        }
        mics = o.getJSONArray("mics").let { a ->
            (0 until a.length()).map { i -> a.getJSONObject(i).let { Mic(it.getString("id"), it.getString("name"), it.getString("hint"), it.getString("group")) } }
        }
        chains = o.getJSONObject("chains")
    }

    fun use(id: String): Use? = uses.firstOrNull { it.id == id }
    fun mic(id: String): Mic? = mics.firstOrNull { it.id == id }
    fun isInstrument(useId: String): Boolean = use(useId)?.group?.let { it != "voice" } ?: false

    /** The chain for a use and a microphone (null if that pair doesn't exist) */
    fun chain(useId: String, micId: String): String? = chains.optJSONObject("$useId|$micId")?.toString()

    /** Switching use keeps the mic when it fits, otherwise picks the use's usual one */
    fun micFor(useId: String, currentMic: String): String {
        val u = use(useId) ?: return currentMic
        return if (currentMic in u.mics) currentMic else u.defaultMic
    }

    companion object {
        fun load(context: Context): Presets = Presets(context.assets.open("presets.json").bufferedReader().use { it.readText() })
    }
}

/** Preset files, the same format as the PC app and the plugin ({ app, version, name, chain }) */
object PresetFiles {
    private const val APP = "gritometro-procesador"

    fun serialize(name: String, chainJson: String): String =
        JSONObject().put("app", APP).put("version", 1).put("name", name).put("chain", JSONObject(chainJson)).toString(2)

    /** (name, chain JSON); throws with a message for the user */
    fun parse(text: String): Pair<String, String> {
        val o = try {
            JSONObject(text)
        } catch (e: Exception) {
            throw IllegalArgumentException("El archivo no es un JSON válido.")
        }
        if (o.optString("app") != APP || !o.has("chain")) throw IllegalArgumentException("No es un preset del procesador.")
        return o.optString("name", "Preset importado").ifBlank { "Preset importado" } to o.getJSONObject("chain").toString()
    }
}
