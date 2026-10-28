# Gritómetro Procesador de Audio Android

The processor of Gritómetro Procesador de Audio as an Android app: the same DSP (noise reduction,
gate/expander, 8-band parametric EQ, de-esser, two compressors, saturator, true-peak limiter) and
the same use × mic presets, for:

- **En vivo**: microphone → processor → headphones, with recording (WAV 24-bit, optionally also
  the unprocessed mic), A/B, meters, LUFS, assistant, learned noise profile, per-channel setups
  for USB interfaces, background processing (foreground service) and an anti-howl guard.
- **Archivo**: open any audio or video Android can decode (WhatsApp voice notes, MP3, M4A, WAV,
  OGG/Opus, FLAC…), or "Compartir" it to the app; listen processed with A/B; export to WAV or M4A,
  latency-compensated and optionally normalized to a LUFS target.
- **Afinador** (same tunings as the PC tuner) and **Grabaciones** (play, share, save to Música,
  reprocess, rename, delete).

Android does not let one app process the microphone of another (calls, Discord, games) without
root, so the app processes its own input and files.

## Layout

```
native/   Rust (cdylib libgritometro_android.so): plugin/src/dsp.rs included as-is (#[path]),
          chain.rs (the app's chain JSON → DSP settings), engine.rs (meters, LUFS, true peak,
          YIN, A/B delay line), lib.rs (JNI: com.gritometro.procesador.audio.Native)
app/      Kotlin + Jetpack Compose: audio/ (LiveEngine, FileEngine/FilePlayer, AudioService,
          Wav), model/ (presets, chain JSON paths, assistant, tuner), ui/
```

The chain is the PC app's JSON, so preset files move freely between PC, plugin and phone.
`app/build.gradle.kts` builds `native/` for arm64-v8a, armeabi-v7a and x86_64 with the NDK's clang
as linker (task `cargoBuild`, before every build) and copies `plugin/presets.json` into the assets.

**A DSP change goes to `plugin/src/dsp.rs` (and the TS app); this app picks it up automatically.**
A chain field added to the app needs the same field in `native/src/chain.rs`.

## Build

Needs the Android SDK (platform 35, NDK 27.2.12479018), JDK 17+, and Rust with the targets
`aarch64-linux-android armv7-linux-androideabi x86_64-linux-android` (cargo on PATH).

```
cd android
cargo test --release --manifest-path native/Cargo.toml   # native DSP tests
./gradlew testDebugUnitTest                              # Kotlin model tests
./gradlew assembleRelease                                # app/build/outputs/apk/release
```

Release signing: set `GRIT_KEYSTORE` (path to the .jks) and `GRIT_KEYSTORE_PASSWORD` (alias
`gritometro`). Without them the release APK is signed with the debug key. Always sign releases with
the same key, or phones refuse the update. CI (`.github/workflows/android.yml`) builds on
`android-vX.Y.Z` releases and attaches the APK when the repository secrets
`ANDROID_KEYSTORE_B64` (base64 of the .jks) and `ANDROID_KEYSTORE_PASSWORD` exist.

Version: `version.properties` (bump `versionCode` on every release).
