---
name: configurar-audio
description: Guía y diagnóstico de audio del Gritómetro - micrófonos, VoiceMeeter Banana, consolas/mezcladoras USB, interfaces multicanal, clipping, calibración a dB SPL y perfiles. Úsalo cuando el medidor no reacciona, satura o mide raro, o cuando el usuario quiere usar VoiceMeeter o una consola.
---

# Configurar y diagnosticar el audio

Código: `core/audio/AudioConfig.ts` (perfiles, `effectiveProfile`), `MicrophoneService.ts` (constraints, `ChannelSplitterNode`, ganancia), `AudioEngine.ts` (estado y mensajes de error), pantalla `ui/screens/AudioScreen.tsx`.

## Modo sencillo vs avanzado
- Sencillo: solo dispositivo + calibración de ruido; todo lo demás usa valores seguros (`effectiveProfile`).
- Avanzado: canal, procesamiento de Windows, frecuencia de muestreo, latencia, ganancia (trim), gate, respuesta (rápida/VU/pico), offset SPL, perfiles y medidor técnico.

## VoiceMeeter Banana
1. Micro en Hardware Input 1 → activar el bus **B1** en esa tira.
2. En el Gritómetro elegir **VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)** (el bus B2 es "VoiceMeeter Aux Output").
3. Frecuencia 48 kHz, igual que VoiceMeeter (Menu → System Settings). Si falla al abrir (`OverconstrainedError`), poner "Automática".
4. Sin compresor/limitador fuerte en la tira (iguala a todos los niños). Un EQ suave está bien.
5. El botón "+ VoiceMeeter" en Audio → Avanzado crea un perfil que ya preselecciona el dispositivo virtual.


### Procesar el micro antes de VoiceMeeter (modo estudio → Procesador)
1. Procesador: micrófono = el micro físico; salida = **VoiceMeeter Input** (o AUX/VAIO3 Input en Banana/Potato); 48 kHz.
2. En VoiceMeeter la tira virtual VAIO (o AUX) recibe la voz procesada: activar B1; **no** enviar la tira del micro físico a B1 (sonaría doble).
3. Discord/OBS/Zoom usan «VoiceMeeter Output» (B1). Para oírse: escucha del procesador por auriculares o A1 en VoiceMeeter.
4. Alternativa si el micro ya entra en VoiceMeeter: entrada del procesador = «VoiceMeeter Out B2», salida = «VoiceMeeter AUX Input».

## Consola / interfaz USB
- Si expone varios canales por USB: "Un canal específico" → el canal del micro. Si solo da el master estéreo: "Mezcla".
- Chromium puede reportar solo 2 canales aunque la interfaz tenga más (limitación del driver WDM de Windows). Prueba el panel del fabricante para exponer más entradas, o rutea con VoiceMeeter.
- Ajusta el gain físico para que un grito fuerte no encienda el LED CLIP.

## Diagnóstico rápido
| Síntoma | Causa probable | Solución |
|---|---|---|
| Medidor quieto | Dispositivo equivocado o silenciado en Windows | Elegir otro; revisar Configuración → Sonido → Entrada |
| "Micrófono ocupado" | Otra app en modo exclusivo | Cerrar Zoom/Discord o desactivar el "modo exclusivo" del dispositivo |
| Todos sacan ~100 | Ruido mal calibrado o dificultad baja | Recalibrar con la fiesta sonando; subir "Dificultad" en Ajustes |
| Nadie pasa de 30 | Ganancia baja | Subir el gain de la consola o el trim (+6/+12 dB) |
| CLIP constante | Ganancia alta | Bajar trim/fader; al saturar, los puntajes se aplastan |
| El volumen sube y baja solo | Procesamiento de Windows activo | Activar "Desactivar procesamiento" |

## Calibrar dB SPL
Pon un sonómetro (app del celular) junto al micro, emite un sonido constante y mueve "Calibración a dB SPL" hasta que coincidan. Es aproximado: el puntaje no depende de este valor.

Para cambios de código, mantén `core/audio` sin React y añade tests de la lógica pura en `ScoreEngine.test.ts`.
