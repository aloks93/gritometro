package com.gritometro.procesador.model

import org.json.JSONArray
import org.json.JSONObject

/**
 * The chain stays as the app's JSON (the same text the PC app saves); the UI reads and writes it
 * by path, e.g. "comp1.thresholdDb" or "eq.bands.3.freq". Every write returns a new string.
 */
class Chain(val json: String) {
    private val root = JSONObject(json)

    private fun parent(path: String): Pair<Any?, String> {
        val parts = path.split('.')
        var node: Any? = root
        for (p in parts.dropLast(1)) {
            node = when (node) {
                is JSONObject -> node.opt(p)
                is JSONArray -> p.toIntOrNull()?.let { node.opt(it) }
                else -> null
            }
        }
        return node to parts.last()
    }

    private fun raw(path: String): Any? {
        val (node, key) = parent(path)
        return when (node) {
            is JSONObject -> node.opt(key)
            is JSONArray -> key.toIntOrNull()?.let { node.opt(it) }
            else -> null
        }
    }

    fun num(path: String, default: Float = 0f): Float = (raw(path) as? Number)?.toFloat() ?: default
    fun bool(path: String, default: Boolean = false): Boolean = raw(path) as? Boolean ?: default
    fun str(path: String, default: String = ""): String = raw(path) as? String ?: default
    fun has(path: String): Boolean = raw(path) != null && raw(path) != JSONObject.NULL

    fun bandCount(): Int = root.optJSONObject("eq")?.optJSONArray("bands")?.length() ?: 0

    fun profile(): FloatArray? {
        val a = root.optJSONObject("noise")?.optJSONArray("profile") ?: return null
        return FloatArray(a.length()) { a.getDouble(it).toFloat() }
    }

    fun with(path: String, value: Any?): Chain {
        val copy = Chain(json)
        val (node, key) = copy.parent(path)
        val v = when (value) {
            is Float -> if (value.isFinite()) value.toDouble() else 0.0
            null -> JSONObject.NULL
            is FloatArray -> JSONArray().also { a -> value.forEach { a.put(it.toDouble()) } }
            else -> value
        }
        when (node) {
            is JSONObject -> node.put(key, v)
            is JSONArray -> key.toIntOrNull()?.let { node.put(it, v) }
        }
        return Chain(copy.root.toString())
    }

    fun withAll(vararg changes: Pair<String, Any?>): Chain = changes.fold(this) { c, (p, v) -> c.with(p, v) }

    override fun toString(): String = json
}
