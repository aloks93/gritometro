---
name: modo-estudio
description: Modo Estudio oculto del Gritómetro - interfaz profesional para probar y comparar micrófonos (medidores, espectro, osciloscopio, tomas, SNR, respuesta en frecuencia, prueba a ciegas A/B, WAV/CSV). Úsalo cuando el usuario quiera comparar micrófonos, saber cuál suena mejor, cambiar o ampliar el modo estudio, o pregunte cómo activarlo.
---

# Modo Estudio

## Cómo se activa (oculto a propósito)
- **Ctrl+Shift+S** en cualquier pantalla (vuelve a pulsarlo para salir), o
- **5 clics rápidos** sobre el título de la pantalla de inicio.
- Para salir: botón "Salir del modo estudio". El modo se guarda en `settings.appMode` ('party' | 'studio').
- No lo muestres en la interfaz de fiesta.

## Código
- Lógica pura: `src/renderer/src/core/studio/analysis.ts` (+ `analysis.test.ts`), modelo `core/studio/studio.ts`.
- UI: `src/renderer/src/ui/studio/` → `StudioShell.tsx` (pestañas), `MonitorView.tsx`, `CompareView.tsx`, `playback.ts`, `studio.css` (estilos propios con prefijo `st-`; redefine las variables `--c-*` para que la pantalla de Audio embebida combine).
- Motor: `audioEngine.spectrumDb()` (FFT 8192), `audioEngine.waveform()`, `audioEngine.captureTake(ms, voicedAboveDb)` (lecturas + espectro de potencia promediado + PCM post-ganancia).

## Monitor
- Medidores RMS/pico, lecturas (cresta, SNR en vivo, SPL aprox., clips), espectro FFT 8192 y osciloscopio.
- **Frecuencia dominante** (Hz + nota musical): para localizar un acople y recortarlo en el EQ.
- **Fijar referencia**: congela el espectro actual (línea morada discontinua) para comparar posiciones o micros en vivo.

## Flujo de comparación (para explicarlo al usuario)
1. Comparador → añadir cada micro (dispositivo, canal, trim, nombre).
2. "Grabar" en cada uno (o **"Grabar todos en orden"**): mide ruido en silencio (mediana + espectro del silencio), cuenta 3-2-1 y graba la toma.
3. Tabla: ruido (y **ruido ponderado A**, **zumbido 50/60 Hz**), nivel, pico (exacto por muestra), SNR, factor de cresta, brillo (centroide), graves/medios/agudos, clips (+ muestras a 0 dBFS), puntuación técnica (0–100) con la nota principal (incluye avisos de zumbido y DC offset), miniatura de forma de onda.
4. Gráfico de respuesta en tercios de octava normalizado (compara la forma, no el volumen).
5. "Prueba a ciegas (A/B)": orden aleatorio, volumen igualado (`matchLoudness`), calificar con estrellas, revelar.
6. Exportar CSV (con `;` y coma decimal para Excel en español) y WAV por toma. El audio de las tomas vive solo en memoria; las métricas sí se guardan.

Consejos para una comparación justa: misma frase, misma distancia y posición, misma ganancia de preamp cuando sea posible; el procesamiento de Windows siempre desactivado (la toma lo fuerza).

## Al modificar
- Mantén `core/studio` sin React ni Web Audio y añade tests con espectros sintéticos (ver helpers en `analysis.test.ts`).
- `technicalScore` es aproximado: SNR pesa más (55), luego nivel (15), clipping (15) y balance tonal (15). Si cambias los pesos, actualiza los tests y explica que la prueba a ciegas es la referencia subjetiva.
- Si añades una pestaña, regístrala en `StudioShell.tsx`.
- `ScriptProcessorNode` está obsoleto pero funciona en Electron; si algún día falla, migra la captura PCM a un `AudioWorklet`.
- Verifica con `npm test`, `npm run typecheck` y abriendo la app (con Electron y `--use-fake-device-for-media-stream` para pruebas automáticas).
