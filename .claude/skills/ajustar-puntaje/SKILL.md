---
name: ajustar-puntaje
description: Ajusta cómo se calcula el puntaje de los gritos en el Gritómetro (sensibilidad, anti-trampa, peso del pico vs promedio, bonus por edad, niveles). Úsalo cuando los puntajes salen muy altos/bajos o injustos, o el usuario quiere cambiar las reglas de puntuación.
---

# Ajustar la puntuación

Lógica: `src/renderer/src/core/audio/ScoreEngine.ts` (`scoreScream`); tests en `ScoreEngine.test.ts`.

## Cómo puntúa hoy
- Nivel por frame = dB por encima del ruido ambiente (`noiseFloorDb` calibrado).
- `sustainedPeak`: el mejor promedio en cualquier ventana de `minBurstMs` (anti-trampa: golpes y aplausos cortos no cuentan).
- `score = (0.7·picoSostenido + 0.3·promedioDeTodaLaVentana) / rangeDb · 100 · multiplicadorEdad`, recortado a 0–100.
- Ajustables sin código (Ajustes del juego): duración del grito, Dificultad (`rangeDb`), Anti-trampa (`minBurstMs`), reglas de bonus por edad.
- Las etiquetas de nivel salen de `texts.levels` de cada tema.

## Antes de tocar código, prueba con los ajustes
- Todos llegan a 100 → subir Dificultad (p. ej. de 50 a 60 dB).
- Nadie pasa de 40 → bajar Dificultad o subir la ganancia (ver `/configurar-audio`).
- Gana quien sopla o golpea el micro → subir Anti-trampa (de 150 a 250 ms).
- Los peques nunca ganan → revisar las reglas de edad (por defecto x1.3 hasta 5 años, x1.15 hasta 8).

## Si hay que cambiar la fórmula
1. Pide (o captura) lecturas reales: en la app, Audio → Avanzado → Medidor técnico; anota los dBFS de ruido, grito normal y grito fuerte.
2. Escribe primero un test en `ScoreEngine.test.ts` con frames sintéticos (helper `constant(db, ms)`) que exprese el comportamiento deseado.
3. Cambia las constantes (`PEAK_WEIGHT`, `AVERAGE_WEIGHT`, `VOICED_MARGIN_DB`) o la fórmula; mantén el resultado en 0–100, redondeado a 1 decimal.
4. `npm test`. Si cambias la escala, avisa de que los récords guardados dejan de ser comparables (ofrece borrar el historial en Récords).
