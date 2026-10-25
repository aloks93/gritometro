# Gritómetro

Electron desktop app that measures who screams loudest into a microphone (one mic, turn-based). Built for a kids' birthday party: themed UIs (default: "Fábrica de Monstruos"), several challenge modes, records, certificates. UI text is Spanish; code and comments are English.

## Commands
- `npm run dev` – app with hot reload
- `npm test` – Vitest (pure logic only: scoring + modes)
- `npm run typecheck` – `tsc --noEmit`
- `npm run build:win` – production build + Windows installer and portable `.exe` in `dist/`

## Architecture (electron-vite layout)
```
src/main/          Electron main: window, mic/webcam permissions, IPC (storage, file save/open, PDF)
src/preload/       contextBridge API exposed as window.gritometro (typed via GritometroApi)
src/renderer/src/
  core/            NO React, NO themes. Pure, testable logic.
    audio/         AudioConfig (profiles, simple/advanced), LevelAnalyzer (RMS/dB/ballistics),
                   MicrophoneService (getUserMedia, channel split, gain), AudioEngine (singleton, rAF loop),
                   Calibration (noise floor), ScoreEngine (scream score + SilenceWatcher)
    game/          GameMode contract, registry, modes/*
    players/       players, teams, avatars, age handicap
    settings/      game settings + defaults
  themes/          Theme contract, registry, one folder per theme
  ui/              React: store (persisted app state), hooks, sound, components/, screens/
  App.tsx          router (Route union in ui/nav.ts), theme CSS vars, audio boot
```

### Rules
- `core/` must stay framework-free so it can be unit tested in Node.
- Game modes are pure: `init → nextTurn → applyResult → standings`. State in, new state out. Never mutate.
- Themes only supply appearance: tokens (→ CSS vars `--c-<token>`, `--font-display`, `--font-body`, `--radius`), texts, optional components (`Meter`, `Background`, `Reveal`), sound style. Generic fallbacks live in `ui/components/Meter.tsx`.
- Custom (user) themes are JSON overrides on a built-in base (`CustomTheme`), resolved by `resolveTheme`. Components always come from the base.
- Persistence: `ui/store.tsx` → `ui/storage.ts` → IPC → `<userData>/data/<key>.json`. New settings fields must have defaults (store merges defaults on load).
- The mic is owned by `audioEngine` only; screens subscribe through `ui/hooks.ts`. `App.tsx` restarts it when the effective profile changes (debounced).
- Simple audio mode ignores advanced knobs via `effectiveProfile()`.

## Extending
- New challenge: `/nuevo-modo` skill (or `core/game/modes/<id>.ts` + `registry.ts` + test in `modes.test.ts`).
- New theme: `/nuevo-tema` skill (or `themes/<id>/index.ts` + `registry.ts`).
- Audio routing (VoiceMeeter, consoles): `/configurar-audio`. Score tuning: `/ajustar-puntaje`.
- Packaging: `/empaquetar`. Pre-party check: `/checklist-fiesta`.

## Notes
- Theme art must be original (no Disney/Pixar logos or characters). Users can upload their own images per custom theme.
- Electron does not support `window.prompt`; use inline inputs. `confirm()` works.
- Verify UI changes by running the app; for automated screenshots launch Electron with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
