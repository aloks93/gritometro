# Gritómetro Plugin (VST3 / CLAP)

El mismo procesador de la app Gritómetro Procesador de Audio, como plugin para tu DAW (Reaper, FL Studio,
Ableton Live, Cubase, Studio One, Bitwig, Audacity…): reducción de ruido, puerta/expansor, EQ
paramétrico de 8 bandas, de-esser, dos compresores, saturador y limitador look-ahead, con los mismos
presets (voz, voces grabadas, bajo, guitarra, batería…) y la misma interfaz.

## Instalar

**Windows**
1. Descomprime el `.zip`.
2. Copia la carpeta `Gritometro Plugin.vst3` en `C:\Program Files\Common Files\VST3\`.
3. (Opcional, para DAWs con CLAP como Reaper o Bitwig) copia `Gritometro Plugin.clap` en
   `C:\Program Files\Common Files\CLAP\`.
4. En tu DAW, vuelve a escanear los plugins y búscalo como **Gritometro Plugin**.

**macOS**
1. Descomprime el `.zip`.
2. Copia `Gritometro Plugin.vst3` en `~/Library/Audio/Plug-Ins/VST3/` y
   `Gritometro Plugin.clap` en `~/Library/Audio/Plug-Ins/CLAP/`.
3. No está firmado por Apple: si el DAW no lo carga, en Terminal:
   `xattr -cr ~/Library/Audio/Plug-Ins/VST3/"Gritometro Plugin.vst3"` (y lo mismo con el `.clap`).

## Uso

- **Uso + micrófono → Aplicar preset**: carga la cadena completa pensada para ese uso. Para limpiar
  y mezclar grabaciones de voz, empieza con **Voces grabadas (limpieza y mezcla)**.
- **Reducción de ruido → Aprender**: reproduce un tramo de la grabación sin voz (solo el ruido de la
  sala) y pulsa *Aprender*; el perfil se guarda con el proyecto.
- **Cargar / Guardar**: los presets son los mismos `.json` que exporta la app; puedes ajustar una voz
  en la app y abrirla aquí, y al revés.
- Perillas: arrastra arriba/abajo (Mayús = fino), rueda del ratón, doble clic = valor inicial.
  En el EQ arrastra los puntos, rueda = ancho (Q), clic derecho = activar/desactivar la banda.
- Latencia fija de ~23 ms a 48 kHz (ventana de la reducción de ruido + look-ahead del limitador):
  el DAW la compensa solo.

## Compilar

Necesita Rust. Desde esta carpeta:

```
cargo test --release                                   # DSP: igual a la app (tests/parity.rs)
cargo xtask bundle gritometro_procesador --release     # target/bundled/*.vst3 y *.clap
cargo run --release --features standalone -- --backend dummy   # la ventana sin DAW
```

`presets.json` y `tests/parity.json` se generan desde el código de la app con
`npm run plugin:presets` (en la raíz del repositorio): así app y plugin nunca se separan.

## Licencia

GPL-3.0-or-later (ver `LICENSE`), como exige el SDK de VST3 que usa nih-plug.
