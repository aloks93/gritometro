# Gritómetro

Electron desktop app that measures who screams loudest into a microphone (one mic, turn-based). Built for a kids' birthday party: themed UIs (default: "Fábrica de Monstruos"), several challenge modes, records, certificates, birthday name (Ajustes → Cumpleañera). UI text is Spanish; code and comments are English.

It also has a **hidden Studio mode** (`settings.appMode = 'studio'`): a professional audio interface (meters, EBU R128 loudness, sound level meter, recorder, mic comparator, signal generator, latency test). Toggle with **Ctrl+Shift+S** or **5 quick clicks on the home title**; exit with the "Salir del modo estudio" button. It is intentionally not listed anywhere in the party UI.

## Commands
- `npm run dev` – app with hot reload
- `npm test` – Vitest (pure logic only: scoring, modes, studio DSP)
- `npm run typecheck` – `tsc --noEmit`
- `npm run build:win` – production build + Windows installer and portable `.exe` in `dist/`
- `npm run build:studio` – standalone **Gritómetro Studio** (same code, `GRIT_EDITION=studio`) in `dist-studio/`
- `npm run build:processor` – standalone **Gritómetro Procesador** (`GRIT_EDITION=processor`) in `dist-procesador/`
- `npm run render:icon` – re-renders `build/processor/icon.svg` → `icon.png` (1024², via Electron)
- `npm run build:mac` / `npm run build:studio:mac` / `npm run build:processor:mac` – macOS dmg/zip (only on a Mac). Releases get them from
  `.github/workflows/macos.yml`, which builds on a Mac runner when a release is published and attaches the files

## Editions
- **Party** (default): the birthday app, with the hidden studio inside. Released as `vX.Y.Z` (marked Latest).
- **Studio**: `__EDITION__ === 'studio'` (define injected by `electron.vite.config.ts`). Opens straight into `StudioShell standalone` (no exit to party, no Ctrl+Shift+S), behind an access code (`core/studio/unlock.ts`, only the SHA-256 is stored; remembered via `settings.studioUnlocked`). Own appId/productName (`electron-builder.studio.yml`) and own data folder `%APPDATA%/Gritometro Studio`. Released separately as `studio-vX.Y.Z` with `--latest=false`.
- **Procesador**: `__EDITION__ === 'processor'`. Only the mic processor (`ProcessorShell`: tabs Procesador → `ProcessorView` and
  Canales → `InterfacesView`, Alt+1/2), no access code,
  no party mic (`useAudioBoot` disabled). Own appId/productName/icon (`electron-builder.processor.yml`, `build/processor/`),
  data folder `%APPDATA%/Gritometro Procesador`. Released as `procesador-vX.Y.Z` with `--latest=false`.
- Studio improvements go to every edition; keep party-only wording out of the studio (`AudioScreen studio` prop).
- Studio language (ES/EN, `prefs.language`, auto = system): the studio is written in Spanish and `ui/studio/i18n.ts`
  translates what it renders (MutationObserver), plus confirm(), PDF reports and CSVs. **New studio texts need an
  English entry in `ui/studio/i18n.en.ts`** (exact text, or a `{0}` pattern for templates). The party app stays Spanish.

## Architecture (electron-vite layout)
```
src/main/          Electron main: window, mic/webcam permissions, IPC (storage, file save/open, PDF, HTML→PDF report,
                   multitrack.ts: multitrack takes streamed to disk, one WAV per track, header sizes patched at the end)
src/preload/       contextBridge API exposed as window.gritometro (typed via GritometroApi)
src/renderer/src/
  core/            NO React, NO themes. Pure, testable logic.
    audio/         AudioConfig (profiles, simple/advanced), LevelAnalyzer (RMS/dB/ballistics),
                   MicrophoneService (getUserMedia, channel split, gain), AudioEngine (singleton, rAF loop,
                   PCM tap via pcmTap.worklet.js, monitoring, output device, scheduled output,
                   setSourceOverride to analyse a mixer bus), MixerEngine (virtual mixer graph,
                   stripGate.worklet.js, busTap.worklet.js),
                   Calibration (noise floor), ScoreEngine (scream score + SilenceWatcher),
                   ProcessorEngine (mic processor graph, processor.worklet.ts bundled via ?worker&url),
                   InputScanner (opens every input at once and meters each channel, for the Interfaces tab)
    game/          GameMode contract, registry, modes/*
    players/       players, teams, avatars, age handicap
    settings/      game settings + defaults (appMode, birthdayName)
    processor/     mic processor: model, 8-band parametric EQ (exact Web Audio biquads), presets use × mic,
                   auto setup; dynamics.ts (gate/expander with key filters, de-esser, compressor with sidechain HPF
                   and auto makeup, saturator, look-ahead limiter) and noise.ts (STFT Wiener noise suppressor,
                   learned or adaptive profile), both shared with processor.worklet.ts; channels.ts (one
                   setup per device channel: switching channel stores the current one and restores the target)
    mixer/         pure mixer model: strips, buses, solo/mute, pan law, fader taper, EQ response,
                   routing warnings, scenes, auto trim (MixerEngine.ts in audio/ builds the graph)
    studio/        pure studio DSP: analysis (third-octave, centroid, SNR, technicalScore, WAV 16/24/float
                   encode+decode), dsp (A/C/K weighting biquads, true peak, generators, findDelay),
                   loudness (EBU R128 LoudnessMeter, IEC SoundLevelMeter), pitch (YIN), report (PDF HTML),
                   studio (StudioData + prefs, session files), distortion (FFT, THD/THD+N), stereo (phase
                   correlation, channel offset, goniometer), acoustics (RT60 Schroeder), feedback (howl detector),
                   calibration (calibrator check, IEC tolerance, history per profile, loopback, gain advice),
                   flac (lossless encoder), session (markers/timecode, clip markers, measurement session + report),
                   health (status lights ok/warning/silence/over/clip/off, level trackers, alarms, hot-plug),
                   hardware (device probe, per-device profiles, auto profile switch, CSV helper),
                   scenario (per-use mic scores: speech/singing/shout/podcast/instrument/room, sensitivity, tonal distance)
  themes/          Theme contract, registry, one folder per theme
  ui/              React: store (persisted app state), hooks, sound, components/, screens/
  ui/studio/       Studio shell (own scoped CSS, does not use party themes). Views (prefs.viewMode): Escenario
                   (big meters, health.tsx StageView), Estudio (all tabs), Medición (measurement tabs only);
                   health LEDs + panel + alarm banner in the topbar. Tabs: Monitor (meters, LUFS,
                   tuner, FFT/RTA/spectrogram/waterfall, scope, headphone monitoring), Sonómetro, Calibración, Grabadora (WAV/FLAC, markers,
                   measurement session JSON/PDF),
                   Mezclador (virtual console: strips with HPF/notch/gate/EQ/comp/limiter/delay/ducking → A/B buses
                   + optional pre-fader aux C buses (stage monitors),
                   pre/post-fader meters, CUE/PFL + headphone monitor, gain staging, anti-feedback, MIDI learn,
                   user presets, scenes,
                   stereo bus recording, auto trim; any bus can feed the analyzers; MultitrackPanel: multitrack
                   recording of strips (input/pre/post) + buses, sample-aligned via trackTap.worklet.js with bus latency
                   compensated, streamed to disk, markers, sesion.json/txt; helpers in core/studio/multitrack.ts),
                   Interfaces (InterfacesView: every interface and channel metered in parallel, click = load that
                   channel in the processor with its own saved setup, names/notes/copy/reset per channel;
                   channels marked live keep running in parallel to their own output: core/audio/MultiProcessor.ts,
                   one ProcessorEngine per live channel, follows the main power button),
                   Procesador (ProcessorView + processor.css + controls.tsx knobs/meters/icons: one mic → noise
                   reduction → gate → parametric EQ → de-esser → comp ×2 → saturator → limiter → VoiceMeeter Input /
                   any output, LUFS/true peak, EQ/dynamics/noise graphs, bypass A/B, presets, auto assistant; no emoji),
                   Comparador (takes, synced A/B, blind test, difference curves, best mic per use, session/PDF),
                   Laboratorio (THD+N, phase/goniometer + mic alignment, room RT60), Equipos (device inventory,
                   capabilities, profiles per device, engine latency), Generador (signals +
                   latency), playback.ts / recordings (in-memory audio, never persisted)
  App.tsx          router (Route union in ui/nav.ts), theme CSS vars, audio boot
```

### Rules
- `core/` must stay framework-free so it can be unit tested in Node.
- Game modes are pure: `init → nextTurn → applyResult → standings`. State in, new state out. Never mutate.
- Themes only supply appearance: tokens (→ CSS vars `--c-<token>`, `--font-display`, `--font-body`, `--radius`), texts, optional components (`Meter`, `Background`, `Reveal`), sound style. Generic fallbacks live in `ui/components/Meter.tsx`.
- Custom (user) themes are JSON overrides on a built-in base (`CustomTheme`), resolved by `resolveTheme`. Components always come from the base.
- Persistence: `ui/store.tsx` → `ui/storage.ts` → IPC → `<userData>/data/<key>.json`. New settings fields must have defaults (store merges defaults on load).
- The mic is owned by `audioEngine` only; screens subscribe through `ui/hooks.ts` (readings) or `audioEngine.onPcm` (raw PCM, only tapped while someone listens). `App.tsx` restarts it when the effective profile changes (debounced); a newer start/stop always wins over a slower one.
- Saving is debounced per key (`saveDebounced`) and serialized per key in main; flush happens on `beforeunload`.
- Simple audio mode ignores advanced knobs via `effectiveProfile()`.

## Extending
- New challenge: `/nuevo-modo` skill (or `core/game/modes/<id>.ts` + `registry.ts` + test in `modes.test.ts`).
- New theme: `/nuevo-tema` skill (or `themes/<id>/index.ts` + `registry.ts`).
- Audio routing (VoiceMeeter, consoles): `/configurar-audio`. Score tuning: `/ajustar-puntaje`.
- Packaging: `/empaquetar`. Pre-party check: `/checklist-fiesta`.
- Studio mode / mic comparison: `/modo-estudio`.

## Notes
- App icon (`build/icon.svg` → `build/icon.png`) is deliberately neutral/professional, because the same exe serves the studio mode. Do not make it kid-themed.
- Theme art must be original (no Disney/Pixar logos or characters). Users can upload their own images per custom theme.
- Electron does not support `window.prompt`; use inline inputs. `confirm()` works.
- Verify UI changes by running the app; for automated screenshots launch Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
