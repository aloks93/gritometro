---
name: modo-estudio
description: Modo Estudio oculto del Gritómetro - interfaz profesional de audio (medidores, LUFS EBU R128, sonómetro A/C/Z con calibración, grabadora, afinador, FFT/RTA/espectrograma, comparador de micrófonos con A/B sincronizado y prueba a ciegas, generador de señales, latencia, informe PDF, WAV/CSV). Úsalo cuando el usuario quiera comparar micrófonos, saber cuál suena mejor, cambiar o ampliar el modo estudio, o pregunte cómo activarlo.
---

# Modo Estudio

## Cómo se activa (oculto a propósito)
- **Ctrl+Shift+S** en cualquier pantalla (vuelve a pulsarlo para salir), o
- **5 clics rápidos** sobre el título de la pantalla de inicio.
- Para salir: botón "Salir del modo estudio". El modo se guarda en `settings.appMode` ('party' | 'studio').
- No lo muestres en la interfaz de fiesta.

## App independiente (Gritómetro Studio)
- `npm run build:studio` → `dist-studio/Gritometro-Studio-<versión>-x64.exe` y `-portable.exe`. Misma base de código: las mejoras del estudio llegan a las dos apps.
- Pide el **código de acceso** la primera vez en cada PC (se recuerda en `settings.studioUnlocked`, datos en `%APPDATA%\Gritometro Studio`). En el código solo está su SHA-256 (`core/studio/unlock.ts`); para cambiarlo, calcula el hash nuevo. **Nunca escribas el código en claro en el repo (es público)**: el test lo lee de `STUDIO_CODE` (`STUDIO_CODE=… npm test`).
- Release aparte: etiqueta `studio-vX.Y.Z`, `gh release create ... --latest=false` para que la del cumpleaños siga siendo la «Latest».

## Código
- Lógica pura en `src/renderer/src/core/studio/` (todo con tests):
  - `analysis.ts`: métricas de toma (ruido, SNR, cresta, centroide, bandas, tercios de octava, zumbido, DC, LUFS/LRA/true peak y tono de la toma), `technicalScore`, curvas de diferencia/suavizado, WAV 16/24/float (codificar y leer).
  - `dsp.ts`: filtros A/C/K (biquads), paso alto, true peak 4×, ruido rosa/blanco, barrido log, clic y `findDelay` (latencia).
  - `loudness.ts`: `LoudnessMeter` (EBU R128: M, S, I, LRA, TP) y `SoundLevelMeter` (A/C/Z, rápido/lento, Leq, máx/mín, LCpeak).
  - `pitch.ts`: YIN, `noteInfo` (solfeo + cents), tono medio de una toma. `report.ts`: HTML del informe PDF. `studio.ts`: `StudioData` + `prefs`, `mergeStudio`, sesiones JSON.
- Motor: `audioEngine.onPcm()` (PCM crudo vía `pcmTap.worklet.js`, con respaldo ScriptProcessor; solo se engancha mientras alguien escucha), `setMonitor(dB|null)`, `setOutputDevice(id)`, `scheduleOutput(samples)` (mismo reloj que el PCM, para latencia), `spectrumDb()`, `waveform()`, `captureTake()`.
- UI en `src/renderer/src/ui/studio/`: `StudioShell.tsx` (pestañas, Ctrl+1…6, salida de audio, ayuda con ?), `MonitorView.tsx`, `SlmView.tsx`, `RecorderView.tsx`, `CompareView.tsx`, `GeneratorView.tsx`; `spectrum.tsx` (FFT/RTA/espectrograma/osciloscopio), `meters.ts` (hooks LUFS/sonómetro/afinador), `widgets.tsx`, `playback.ts` (tomas en memoria, grupo A/B sincronizado), `generator.ts`. Estilos con prefijo `st-` en `studio.css`.

## Pestañas
- **Monitor**: RMS/pico, cresta, SNR en vivo, SPL aprox., clips; **sonoridad EBU R128** con objetivo (−14/−16/−23/−24 LUFS); **afinador** (La4 configurable); analizador **FFT** (cursor con Hz/nota/dB, referencia congelada, retención de picos), **RTA 1/3 de octava** y **espectrograma**; suavizado y rango; osciloscopio con disparo; **escucha por auriculares** (nunca se enciende sola al entrar).
- **Sonómetro**: LAF/LAS/LCF… grande, Leq, máx/mín, LCpeak, historial de 2 min, **calibración con calibrador de 94/114 dB** (guarda `splOffset` en el perfil activo), registro exportable a CSV.
- **Grabadora**: grabación libre (máx. 15 min) con LUFS en vivo, marcadores (M), importar WAV, reproducir desde un punto/bucle, exportar WAV 16/24/float o **normalizado** al objetivo LUFS con techo de −1 dBTP.
- **Comparador**: ver flujo abajo.
- **Generador**: seno/cuadrada/ruido rosa/blanco/barrido con nivel en dBFS (sigue sonando entre pestañas) y **latencia ida y vuelta** con 5 clics (loopback o micro + altavoz).

## Flujo de comparación (para explicarlo al usuario)
1. Comparador → añadir cada micro (dispositivo, canal, trim, nombre).
2. "Grabar" en cada uno (o **"Grabar todos en orden"**): mide ruido en silencio (mediana + espectro del silencio), cuenta 3-2-1 y graba la toma.
3. Tabla: ruido (y **ruido ponderado A**, **zumbido 50/60 Hz**), nivel (+ **LUFS**), pico exacto (+ **true peak**), SNR, factor de cresta, brillo (+ **tono medio de la voz**), graves/medios/agudos, clips (+ muestras a 0 dBFS), puntuación técnica (0–100, desglose al pasar el ratón), observaciones por micro, miniatura de forma de onda, reordenar ▲▼.
4. Gráfico de respuesta en tercios de octava normalizado; **"Comparar contra"** muestra la diferencia frente a un micro de referencia; suavizado y leyenda clicable para ocultar curvas.
5. **A/B sincronizado**: todas las tomas suenan a la vez en bucle y se cambia al instante (teclas 1–9) en el mismo punto. **Prueba a ciegas**: orden aleatorio, volumen igualado (`matchLoudness`), también en modo sincronizado; calificar con estrellas y revelar.
6. Exportar CSV (con `;` y coma decimal para Excel en español), **informe PDF**, WAV por toma (formato elegido en la Grabadora) y **guardar/abrir sesión** (JSON con las mediciones). El audio de las tomas vive solo en memoria; las métricas sí se guardan.

Consejos para una comparación justa: misma frase, misma distancia y posición, misma ganancia de preamp cuando sea posible; el procesamiento de Windows siempre desactivado (la toma lo fuerza).

## Al modificar
- Mantén `core/studio` sin React ni Web Audio y añade tests con espectros sintéticos (ver helpers en `analysis.test.ts`).
- `technicalScore` es aproximado: SNR pesa más (55), luego nivel (15), clipping (15) y balance tonal (15). Si cambias los pesos, actualiza los tests y explica que la prueba a ciegas es la referencia subjetiva.
- Si añades una pestaña, regístrala en `StudioShell.tsx`.
- La captura PCM usa un `AudioWorklet` (`pcmTap.worklet.js`, importado con `?url&no-inline` porque la CSP bloquea `data:`); `ScriptProcessorNode` queda solo como respaldo.
- Para capturas automáticas la ventana debe estar visible: oculta, Chromium frena `requestAnimationFrame` y los medidores/espectrograma no avanzan.
- Verifica con `npm test`, `npm run typecheck` y abriendo la app (con Electron y `--use-fake-device-for-media-stream` para pruebas automáticas).
