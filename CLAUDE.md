# Gritómetro

Electron desktop app that measures who screams loudest into a microphone (one mic, turn-based). Built for a kids' birthday party: themed UIs (default: "Fábrica de Monstruos"), several challenge modes, records, certificates, birthday name (Ajustes → Cumpleañera). UI text is Spanish; code and comments are English.

It also has a **hidden Studio mode** (`settings.appMode = 'studio'`): a professional audio interface (meters, EBU R128 loudness, sound level meter, recorder, mic comparator, signal generator, latency test). Toggle with **Ctrl+Shift+S** or **5 quick clicks on the home title**; exit with the "Salir del modo estudio" button. It is intentionally not listed anywhere in the party UI.

## Commands
- `npm run dev` – app with hot reload
- `npm test` – Vitest (pure logic only: scoring, modes, studio DSP)
- `npm run typecheck` – `tsc --noEmit`
- `npm run build:win` – production build + Windows installer and portable `.exe` in `dist/`
- `npm run build:studio` – standalone **Gritómetro Studio** (same code, `GRIT_EDITION=studio`) in `dist-studio/`

## Editions
- **Party** (default): the birthday app, with the hidden studio inside. Released as `vX.Y.Z` (marked Latest).
- **Studio**: `__EDITION__ === 'studio'` (define injected by `electron.vite.config.ts`). Opens straight into `StudioShell standalone` (no exit to party, no Ctrl+Shift+S), behind an access code (`core/studio/unlock.ts`, only the SHA-256 is stored; remembered via `settings.studioUnlocked`). Own appId/productName (`electron-builder.studio.yml`) and own data folder `%APPDATA%/Gritometro Studio`. Released separately as `studio-vX.Y.Z` with `--latest=false`.
- Studio improvements go to both editions; keep party-only wording out of the studio (`AudioScreen studio` prop).

## Architecture (electron-vite layout)
```
src/main/          Electron main: window, mic/webcam permissions, IPC (storage, file save/open, PDF, HTML→PDF report)
src/preload/       contextBridge API exposed as window.gritometro (typed via GritometroApi)
src/renderer/src/
  core/            NO React, NO themes. Pure, testable logic.
    audio/         AudioConfig (profiles, simple/advanced), LevelAnalyzer (RMS/dB/ballistics),
                   MicrophoneService (getUserMedia, channel split, gain), AudioEngine (singleton, rAF loop,
                   PCM tap via pcmTap.worklet.js, monitoring, output device, scheduled output),
                   Calibration (noise floor), ScoreEngine (scream score + SilenceWatcher)
    game/          GameMode contract, registry, modes/*
    players/       players, teams, avatars, age handicap
    settings/      game settings + defaults (appMode, birthdayName)
    studio/        pure studio DSP: analysis (third-octave, centroid, SNR, technicalScore, WAV 16/24/float
                   encode+decode), dsp (A/C/K weighting biquads, true peak, generators, findDelay),
                   loudness (EBU R128 LoudnessMeter, IEC SoundLevelMeter), pitch (YIN), report (PDF HTML),
                   studio (StudioData + prefs, session files)
  themes/          Theme contract, registry, one folder per theme
  ui/              React: store (persisted app state), hooks, sound, components/, screens/
  ui/studio/       Studio shell (own scoped CSS, does not use party themes): Monitor (meters, LUFS,
                   tuner, FFT/RTA/spectrogram, scope, headphone monitoring), Sonómetro, Grabadora,
                   Comparador (takes, synced A/B, blind test, difference curves, session/PDF),
                   Generador (signals + latency), playback.ts / recordings (in-memory audio, never persisted)
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
