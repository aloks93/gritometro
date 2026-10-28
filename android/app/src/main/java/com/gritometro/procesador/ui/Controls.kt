package com.gritometro.procesador.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

// The PC processor's look (processor.css): dark panels, blue accent, green / amber / red levels
object C {
    val bg = Color(0xFF0B0D10)
    val panel = Color(0xFF12151A)
    val panel2 = Color(0xFF171B21)
    val line = Color(0xFF232831)
    val line2 = Color(0xFF2E3440)
    val text = Color(0xFFE3E7ED)
    val dim = Color(0xFF7F8898)
    val accent = Color(0xFF3FB6FF)
    val ok = Color(0xFF4ADE80)
    val warn = Color(0xFFFFB020)
    val bad = Color(0xFFFF4D5E)
    val teal = Color(0xFF4DD6C4)
}

val Mono = FontFamily.Monospace

@Composable
fun ProcTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = C.accent, onPrimary = Color(0xFF00121F), background = C.bg, surface = C.panel, onSurface = C.text,
            onBackground = C.text, surfaceVariant = C.panel2, onSurfaceVariant = C.dim, outline = C.line2, secondary = C.teal,
            error = C.bad, surfaceContainer = C.panel, surfaceContainerHigh = C.panel2, surfaceContainerLow = C.panel,
        ),
        content = content,
    )
}

/** How a knob maps its 0..1 travel to a value */
enum class Scale { Lin, Log, Off }

data class Param(
    val path: String,
    val label: String,
    val min: Float,
    val max: Float,
    val unit: String = "",
    val scale: Scale = Scale.Lin,
    val decimals: Int = 1,
)

fun toNorm(v: Float, p: Param): Float = when (p.scale) {
    Scale.Lin -> (v - p.min) / (p.max - p.min)
    Scale.Log -> (ln(v / p.min) / ln(p.max / p.min))
    Scale.Off -> (v / p.max).coerceAtLeast(0f).pow(1f / 3f)
}.coerceIn(0f, 1f)

fun fromNorm(n: Float, p: Param): Float {
    val x = n.coerceIn(0f, 1f)
    val v = when (p.scale) {
        Scale.Lin -> p.min + x * (p.max - p.min)
        Scale.Log -> p.min * (p.max / p.min).pow(x)
        Scale.Off -> p.max * x.pow(3)
    }
    val step = 10f.pow(-p.decimals)
    return ((v / step).roundToInt() * step).let { if (p.scale == Scale.Off && it < 20f) 0f else it }
}

fun formatValue(v: Float, p: Param): String {
    if (p.scale == Scale.Off && v < 20f) return "OFF"
    if (p.unit == "Hz") return if (v >= 1000f) String.format(Locale.US, "%.1f kHz", v / 1000f) else "${v.roundToInt()} Hz"
    val d = if (p.decimals <= 0 || (p.scale == Scale.Log && v >= 100f)) 0 else p.decimals
    return String.format(Locale.US, "%.${d}f", v) + if (p.unit.isNotEmpty()) " ${p.unit}" else ""
}

/** A rotary knob: drag up/down to turn, double-tap to reset */
@Composable
fun Knob(value: Float, p: Param, onChange: (Float) -> Unit, modifier: Modifier = Modifier, default: Float? = null, enabled: Boolean = true, size: Dp = 58.dp) {
    val current by rememberUpdatedState(value)
    val change by rememberUpdatedState(onChange)
    var norm by remember { mutableFloatStateOf(0f) }
    val color = if (enabled) C.accent else C.dim
    Column(modifier.width(size + 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(size)
                .pointerInput(p) {
                    detectVerticalDragGestures(
                        onDragStart = { norm = toNorm(current, p) },
                        onVerticalDrag = { ch, dy ->
                            ch.consume()
                            norm = (norm - dy / (size.toPx() * 3.2f)).coerceIn(0f, 1f)
                            change(fromNorm(norm, p))
                        },
                    )
                }
                .pointerInput(p, default) {
                    detectTapGestures(onDoubleTap = { default?.let { change(it) } })
                },
            contentAlignment = Alignment.Center,
        ) {
            val n = toNorm(value, p)
            Canvas(Modifier.size(size)) {
                val stroke = 5.dp.toPx()
                val inset = stroke / 2 + 2.dp.toPx()
                val arcSize = Size(this.size.width - inset * 2, this.size.height - inset * 2)
                drawArc(C.line2, 135f, 270f, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
                drawArc(color, 135f, 270f * n, false, Offset(inset, inset), arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
                val r = this.size.width / 2 - inset - 7.dp.toPx()
                drawCircle(C.panel2, r)
                val a = Math.toRadians((135 + 270 * n).toDouble())
                val c = center
                drawLine(C.text, c + Offset((cos(a) * r * 0.25).toFloat(), (sin(a) * r * 0.25).toFloat()), c + Offset((cos(a) * r * 0.85).toFloat(), (sin(a) * r * 0.85).toFloat()), 2.5.dp.toPx(), StrokeCap.Round)
            }
        }
        Text(formatValue(value, p), color = C.text, fontSize = 11.sp, fontFamily = Mono, maxLines = 1)
        Text(p.label, color = C.dim, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
    }
}

/** dB → 0..1 of a meter spanning `floor`..0 dB */
private fun meterFrac(db: Float, floor: Float = -60f) = ((db - floor) / -floor).coerceIn(0f, 1f)

/** Horizontal level meter (peak bar + RMS), green / amber / red */
@Composable
fun LevelBar(label: String, peakDb: Float, rmsDb: Float, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = C.dim, fontSize = 11.sp, modifier = Modifier.width(30.dp))
        Canvas(Modifier.weight(1f).height(12.dp).clip(RoundedCornerShape(3.dp)).background(C.panel2)) {
            val w = size.width
            val p = meterFrac(peakDb) * w
            val r = meterFrac(rmsDb) * w
            val c = when {
                peakDb > -1f -> C.bad
                peakDb > -9f -> C.warn
                else -> C.ok
            }
            drawRect(c.copy(alpha = 0.35f), size = Size(p, size.height))
            drawRect(c, size = Size(r, size.height))
            for (db in listOf(-48f, -36f, -24f, -12f, -6f)) {
                val x = meterFrac(db) * w
                drawLine(C.bg.copy(alpha = 0.6f), Offset(x, 0f), Offset(x, size.height), 1f)
            }
        }
        Text(if (peakDb <= -99f) "−∞" else String.format(Locale.US, "%.1f", peakDb), color = C.text, fontSize = 11.sp, fontFamily = Mono, textAlign = TextAlign.End, modifier = Modifier.width(44.dp))
    }
}

/** Gain reduction (dB ≤ 0) as a bar growing from the right */
@Composable
fun GrBar(label: String, grDb: Float, modifier: Modifier = Modifier, range: Float = 24f) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = C.dim, fontSize = 11.sp, modifier = Modifier.width(64.dp), maxLines = 1)
        Canvas(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(2.dp)).background(C.panel2)) {
            val f = (-grDb / range).coerceIn(0f, 1f) * size.width
            drawRect(C.warn, Offset(size.width - f, 0f), Size(f, size.height))
        }
        Text(String.format(Locale.US, "%.1f", grDb.coerceAtMost(0f)), color = C.text, fontSize = 11.sp, fontFamily = Mono, textAlign = TextAlign.End, modifier = Modifier.width(44.dp))
    }
}

@Composable
fun Led(on: Boolean, color: Color = C.ok, size: Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(if (on) color else C.line2))
}

/** A segmented choice: options (value, label) */
@Composable
fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.clip(RoundedCornerShape(8.dp)).border(1.dp, C.line2, RoundedCornerShape(8.dp))) {
        options.forEachIndexed { i, (v, label) ->
            val on = v == selected
            Box(
                Modifier
                    .weight(1f)
                    .background(if (on) C.accent.copy(alpha = 0.22f) else Color.Transparent)
                    .clickable { onSelect(v) }
                    .padding(vertical = 8.dp, horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, color = if (on) C.accent else C.text, fontSize = 13.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (i < options.size - 1) Spacer(Modifier.width(1.dp).height(36.dp).background(C.line2))
        }
    }
}

@Composable
fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(C.panel)
            .border(1.dp, C.line, RoundedCornerShape(12.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

@Composable
fun Banner(text: String, color: Color = C.warn, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(color.copy(alpha = 0.14f))
            .border(1.dp, color.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) { Text(text, color = color, fontSize = 13.sp) }
}

fun formatTime(seconds: Double): String {
    val s = seconds.coerceAtLeast(0.0).toInt()
    return "%d:%02d".format(s / 60, s % 60)
}
