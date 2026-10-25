# Graph Report - Gritometro  (2026-10-25)

## Corpus Check
- 122 files · ~87,023 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1071 nodes · 2851 edges · 60 communities (52 shown, 8 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.84)
- Token cost: 54,291 input · 0 output

## Community Hubs (Navigation)
- Audio Config & Profiles
- Game Modes
- Mixer Engine Graph
- System Health & Generators
- Mixer Model & Tests
- Mic Comparator
- Party Screens & Scoring UI
- Mixer UI Controls
- Lab: RT60, THD, Stereo
- Level Analysis & Calibration
- Calibration Workflow
- Measurement Session
- Themes
- Take Analysis
- Filters & True Peak
- Custom Themes & Persistence
- FLAC Encoder
- Package Metadata
- Players & Teams
- Mixer Gain & EQ Math
- Monitor View
- App Navigation & Layout
- TypeScript Config
- Game Settings
- Comparison Report
- Weighting Filter Tests
- App Shell
- Score Tuning Docs
- Electron Main & Storage
- Studio Meter Hooks
- Dev Dependencies
- Generator & Latency
- Studio Data & Prefs
- Spectrum & PNG Export
- MIDI & Presets
- Studio Mode Docs
- Feedback Detector
- Audio Setup Docs
- Architecture Docs: App & Themes
- Party Sounds
- Architecture Docs: Audio & Studio
- Architecture Docs: Editions
- NPM Scripts
- Sound Level Meter
- Project Overview Docs
- Architecture Docs: Game Core
- Build Config
- Runtime Dependencies
- Packaging Docs
- Theme Docs
- Architecture Docs: Studio DSP
- Preload API
- Bus Tap Worklet
- Strip Gate Worklet
- Build Script Allowlist
- Studio Build Script
- PCM Tap Worklet
- Core Purity & Tests
- Main/Preload Docs

## God Nodes (most connected - your core abstractions)
1. `useStore()` - 49 edges
2. `audioEngine` - 46 edges
3. `react` - 36 edges
4. `CompareView()` - 35 edges
5. `mixerEngine` - 31 edges
6. `GameScreen()` - 28 edges
7. `MixerView()` - 26 edges
8. `MonitorView()` - 22 edges
9. `Shell()` - 18 edges
10. `useEngineState()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Skill: modo-estudio` --references--> `electron-builder.studio.yml (Gritometro Studio packaging)`  [INFERRED]
  .claude/skills/modo-estudio/SKILL.md → electron-builder.studio.yml
- `technicalScore weights (SNR 55, level 15, clipping 15, tonal 15)` --semantically_similar_to--> `Scream score formula (0.7 sustained peak + 0.3 average)`  [INFERRED] [semantically similar]
  .claude/skills/modo-estudio/SKILL.md → .claude/skills/ajustar-puntaje/SKILL.md
- `electron-builder.yml (party packaging)` --implements--> `Portable Windows .exe`  [INFERRED]
  electron-builder.yml → .claude/skills/empaquetar/SKILL.md
- `PCM tap AudioWorklet (pcmTap.worklet.js)` --rationale_for--> `Renderer Content-Security-Policy`  [INFERRED]
  .claude/skills/modo-estudio/SKILL.md → src/renderer/index.html
- `Hidden Studio Mode` --conceptually_related_to--> `Hidden studio activation (Ctrl+Shift+S / 5 clicks)`  [EXTRACTED]
  CLAUDE.md → .claude/skills/modo-estudio/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Party preparation workflow (package, audio setup, score tuning)** — _claude_skills_checklist_fiesta_skill, _claude_skills_empaquetar_skill, _claude_skills_configurar_audio_skill, _claude_skills_ajustar_puntaje_skill [EXTRACTED 1.00]
- **Scream scoring inputs** — _claude_skills_ajustar_puntaje_skill_scream_score_formula, _claude_skills_ajustar_puntaje_skill_sustained_peak_anti_cheat, _claude_skills_ajustar_puntaje_skill_age_handicap, _claude_skills_ajustar_puntaje_skill_difficulty_rangedb, _claude_skills_ajustar_puntaje_skill_noise_floor_calibration [EXTRACTED 1.00]
- **Persistence flow (store → storage → IPC → main)** — claude_store, src_renderer_src_ui_storage, claude_preload_api, claude_main_process, claude_savedebounced [EXTRACTED 1.00]
- **Audio capture and analysis pipeline** — claude_audioengine, claude_microphoneservice, claude_levelanalyzer, claude_audio_worklets, claude_mixerengine, claude_scoreengine [INFERRED 0.85]
- **Party vs Studio edition build system** — claude_party_edition, claude_studio_edition, claude_edition_define, electron_vite_config, claude_electron_builder_studio, claude_studio_unlock [EXTRACTED 1.00]

## Communities (60 total, 8 thin omitted)

### Community 0 - "Audio Config & Profiles"
Cohesion: 0.06
Nodes (35): AudioProfile, createProfile(), defaultAudioSettings(), isVirtualDevice(), LatencyHint, VIRTUAL_PATTERNS, audioEngine, createTap() (+27 more)

### Community 1 - "Game Modes"
Cohesion: 0.08
Nodes (35): AnyGameMode, ConfigField, fmtPoints(), fmtSeconds(), GameContext, GameMode, ModeView, playerName() (+27 more)

### Community 2 - "Mixer Engine Graph"
Cohesion: 0.06
Nodes (29): analyser(), BusLevel, BusNodes, chain(), ChannelLevel, describe(), join(), mixerEngine (+21 more)

### Community 3 - "System Health & Generators"
Cohesion: 0.07
Nodes (37): logSweep(), pinkNoise(), whiteNoise(), alarmsOf(), deviceChanges(), evaluateHealth(), fmt(), HealthGroup (+29 more)

### Community 4 - "Mixer Model & Tests"
Cohesion: 0.07
Nodes (36): applyProcessing(), BusKind, defaultBuses(), defaultMixer(), Duck, EqBand, EqBandType, FADER_MAX (+28 more)

### Community 5 - "Mic Comparator"
Cohesion: 0.12
Nodes (34): matchGain(), pcmRms(), mergeCandidates(), parseSession(), serializeSession(), saveHtmlAsPdf(), toBase64(), COLORS (+26 more)

### Community 6 - "Party Screens & Scoring UI"
Cohesion: 0.17
Nodes (24): react, effectiveProfile(), normalizeLevel(), ScoreResult, Turn, levelLabel(), Certificate(), Meter() (+16 more)

### Community 7 - "Mixer UI Controls"
Cohesion: 0.12
Nodes (31): applyPreset(), autoTrim(), createStrip(), defaultEqBands(), describeMidiKey(), faderToPos(), posToFader(), serializeMixer() (+23 more)

### Community 8 - "Lab: RT60, THD, Stereo"
Cohesion: 0.14
Nodes (28): energyEnvelope(), fitSlope(), measureRt60(), Rt60Result, rt60Verdict(), blackmanHarris(), DistortionResult, distortionVerdict() (+20 more)

### Community 9 - "Level Analysis & Calibration"
Cohesion: 0.11
Nodes (19): Ballistics, noiseFloorFrom(), analyzeFrame(), BALLISTICS, CLIP_THRESHOLD, LevelReading, MIN_DB, peak() (+11 more)

### Community 10 - "Calibration Workflow"
Cohesion: 0.15
Nodes (27): CalibrationMethod, CalibrationRecord, calibrationWarnings(), checkCalibratorSignal(), GainAdvice, LoopbackPoint, LoopbackResult, pushCalibration() (+19 more)

### Community 11 - "Measurement Session"
Cohesion: 0.17
Nodes (28): buildSession(), buildSessionReportHtml(), clipMarkers(), f1(), Marker, markersCsv(), parseMeasurementSession(), serializeMeasurementSession() (+20 more)

### Community 12 - "Themes"
Cohesion: 0.11
Nodes (22): arcoirisTheme, clasicoTheme, DoorReveal(), DOORS, FactoryBackground(), fabricaMonstruosTheme, BUBBLES, ScreamTank() (+14 more)

### Community 13 - "Take Analysis"
Cohesion: 0.19
Nodes (24): aWeightingDb(), aWeightingOffset(), BAND_CENTERS, bandCurve(), bandShares(), binHz(), curveDifference(), dbToPower() (+16 more)

### Community 14 - "Filters & True Peak"
Cohesion: 0.12
Nodes (14): FilterChain, kWeighting(), POLYPHASE, TruePeakMeter, calibrationOffset(), gatedLoudness(), LoudnessMeter, loudnessRange() (+6 more)

### Community 15 - "Custom Themes & Persistence"
Cohesion: 0.17
Nodes (22): saveDebounced (per-key debounced save), customFromBuiltIn(), getBuiltIn(), isCustomTheme(), resolveTheme(), CustomizeScreen(), MediaField(), TEXT_FIELDS (+14 more)

### Community 16 - "FLAC Encoder"
Cohesion: 0.19
Nodes (14): BitWriter, CRC16, CRC8, encodeFlac(), FlacBits, planRice(), quantize(), residuals() (+6 more)

### Community 17 - "Package Metadata"
Cohesion: 0.11
Nodes (17): author, description, main, name, private, version, canvas-confetti, electron-builder (+9 more)

### Community 18 - "Players & Teams"
Cohesion: 0.22
Nodes (16): ctxOf(), autoTeams(), AvatarSpec, createPlayer(), handicapFor(), newId(), Player, randomAvatar() (+8 more)

### Community 19 - "Mixer Gain & EQ Math"
Cohesion: 0.21
Nodes (17): dbToGain(), eqResponse(), eqSections(), isAudible(), logFreqs(), panGains(), stripOutputGain(), Biquad (+9 more)

### Community 20 - "Monitor View"
Cohesion: 0.26
Nodes (16): activeProfile(), noteName(), noteInfo, LoudnessPanel(), LUFS_PRESETS, MonitorControls(), MonitorView(), TunerPanel() (+8 more)

### Community 21 - "App Navigation & Layout"
Cohesion: 0.27
Nodes (13): getMode(), Field(), Screen(), Slider(), useReading(), GameSession, Navigate, Route (+5 more)

### Community 22 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, baseUrl, esModuleInterop, isolatedModules, jsx, lib, module, moduleResolution (+9 more)

### Community 23 - "Game Settings"
Cohesion: 0.19
Nodes (15): AudioSettings, HandicapRule, AppMode, defaultGameSettings(), GameSettings, CustomTheme, load(), saveDebounced() (+7 more)

### Community 24 - "Comparison Report"
Cohesion: 0.19
Nodes (13): clamp(), technicalScore(), buildReportHtml(), chartSvg(), escapeHtml(), fmt(), REPORT_COLORS, ReportOptions (+5 more)

### Community 25 - "Weighting Filter Tests"
Cohesion: 0.20
Nodes (10): aWeighting(), cWeighting(), digitalPole(), normalizeAt1k(), section(), detectPitch(), LETTERS, medianPitch() (+2 more)

### Community 26 - "App Shell"
Cohesion: 0.23
Nodes (8): App(), Shell(), useAudioBoot(), useThemeVars(), AppBackground(), Props, ScreenErrorBoundary, UnlockScreen()

### Community 27 - "Score Tuning Docs"
Cohesion: 0.19
Nodes (10): Skill: ajustar-puntaje, Age bonus multiplier, Noise floor calibration (noiseFloorDb), Skill: checklist-fiesta, Suggested challenge order (Ranking, Torneo, Tanque, Silencio), <userData>/data/*.json persisted data, Skill: nuevo-modo, createAttemptsMode factory (+2 more)

### Community 28 - "Electron Main & Storage"
Cohesion: 0.32
Nodes (8): setupIpc(), dataDir(), dataPath(), fileFor(), queues, readKey(), writeKey(), writeNow()

### Community 29 - "Studio Meter Hooks"
Cohesion: 0.26
Nodes (11): TimeWeighting, Weighting, SlmSample, useLoudness(), usePcmMeter(), usePitch(), useSoundLevel(), HistoryChart() (+3 more)

### Community 30 - "Dev Dependencies"
Cohesion: 0.17
Nodes (12): devDependencies, electron, electron-builder, electron-vite, @types/canvas-confetti, @types/node, @types/react, @types/react-dom (+4 more)

### Community 31 - "Generator & Latency"
Cohesion: 0.30
Nodes (11): joinChunks(), clickBurst(), findDelay(), summarizeLatency(), GeneratorView(), LatencyPanel(), PRESETS, toHz() (+3 more)

### Community 32 - "Studio Data & Prefs"
Cohesion: 0.24
Nodes (11): TakeMetrics, WavFormat, ToleranceClass, defaultSessionMeta(), SessionMeta, defaultStudio(), defaultStudioPrefs(), mergeStudio() (+3 more)

### Community 33 - "Spectrum & PNG Export"
Cohesion: 0.27
Nodes (10): SpectrumMode, saveCanvasPng(), fmtHz(), fOfX(), FREQ_LABELS, fx(), heat(), Props (+2 more)

### Community 34 - "MIDI & Presets"
Cohesion: 0.27
Nodes (10): applyMidi(), learnMidi(), midiKey(), parseMidi(), STRIP_PRESETS, decay(), spectrum(), rng() (+2 more)

### Community 35 - "Studio Mode Docs"
Cohesion: 0.22
Nodes (8): Skill: modo-estudio, EBU R128 loudness (LoudnessMeter), Round-trip latency test (findDelay), Mic comparison flow (takes, A/B sync, blind test), Separate studio release (studio-vX.Y.Z, --latest=false), technicalScore weights (SNR 55, level 15, clipping 15, tonal 15), Renderer index.html, Renderer Content-Security-Policy

### Community 36 - "Feedback Detector"
Cohesion: 0.22
Nodes (6): DEFAULT_FEEDBACK_OPTIONS, FeedbackCandidate, FeedbackDetector, FeedbackOptions, round1(), Track

### Community 37 - "Audio Setup Docs"
Cohesion: 0.22
Nodes (8): Difficulty (rangeDb), Skill: configurar-audio, Quick audio diagnostics table, dB SPL calibration offset, USB console / multichannel interface, VoiceMeeter Banana routing, SoundLevelMeter (A/C/Z, Leq, 94/114 dB calibrator), Virtual mixer console (strips, A/B buses, scenes)

### Community 38 - "Architecture Docs: App & Themes"
Cohesion: 0.22
Nodes (8): App.tsx (router, theme vars, audio boot), AudioConfig (profiles, simple/advanced), CustomTheme / resolveTheme, effectiveProfile(), Fábrica de Monstruos theme, Generic Meter fallback (ui/components/Meter.tsx), /configurar-audio skill, /nuevo-tema skill

### Community 39 - "Party Sounds"
Cohesion: 0.31
Nodes (8): SoundStyle, ac(), makeSounds(), playUrl(), Sounds, synth, tone(), useSounds()

### Community 40 - "Architecture Docs: Audio & Studio"
Cohesion: 0.32
Nodes (8): Audio worklets (pcmTap, stripGate, busTap), AudioEngine (singleton), Mic Comparator (A/B, blind test), MicrophoneService, core/mixer pure mixer model, MixerEngine, Studio tabs (Monitor, Sonómetro, Grabadora, Mezclador, Comparador, Generador), StudioShell

### Community 41 - "Architecture Docs: Editions"
Cohesion: 0.25
Nodes (8): AudioScreen studio prop, __EDITION__ define, electron-builder.studio.yml, Game settings + defaults (appMode, birthdayName), /empaquetar skill, ui/store.tsx (persisted app state), Studio Edition (Gritómetro Studio), Studio Access Code (core/studio/unlock.ts)

### Community 42 - "NPM Scripts"
Cohesion: 0.25
Nodes (8): scripts, build, build:studio, build:win, dev, preview, test, typecheck

### Community 43 - "Sound Level Meter"
Cohesion: 0.32
Nodes (3): ampToDb(), round1(), SoundLevelMeter

### Community 44 - "Project Overview Docs"
Cohesion: 0.29
Nodes (5): Gritómetro, Party Edition, /checklist-fiesta skill, /modo-estudio skill, Hidden Studio Mode

### Community 45 - "Architecture Docs: Game Core"
Cohesion: 0.29
Nodes (6): Game mode registry, LevelAnalyzer, Players, teams, avatars, age handicap, ScoreEngine + SilenceWatcher, /ajustar-puntaje skill, /nuevo-modo skill

### Community 46 - "Build Config"
Cohesion: 0.29
Nodes (4): define, electron-vite, @vitejs/plugin-react, vitest

### Community 47 - "Runtime Dependencies"
Cohesion: 0.33
Nodes (6): dependencies, canvas-confetti, @fontsource/luckiest-guy, @fontsource/nunito, react, react-dom

### Community 48 - "Packaging Docs"
Cohesion: 0.50
Nodes (5): Skill: empaquetar, Portable Windows .exe, Unsigned exe / SmartScreen warning, electron-builder.yml (party packaging), electron-builder.studio.yml (Gritometro Studio packaging)

### Community 50 - "Architecture Docs: Studio DSP"
Cohesion: 0.40
Nodes (5): Calibration (noise floor), EBU R128 LoudnessMeter, IEC SoundLevelMeter (A/C/Z weighting), core/studio DSP (analysis, dsp, loudness, pitch, report), YIN pitch detection

### Community 51 - "Preload API"
Cohesion: 0.40
Nodes (4): electron, api, GritometroApi, Window

### Community 54 - "Build Script Allowlist"
Cohesion: 0.50
Nodes (4): allowScripts, electron@36.9.5, electron-winstaller@5.4.0, esbuild@0.25.12

## Knowledge Gaps
- **40 isolated node(s):** `electron-builder`, `@types/canvas-confetti`, `@types/node`, `@types/react`, `@types/react-dom` (+35 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 301 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Party Screens & Scoring UI` to `Audio Config & Profiles`, `System Health & Generators`, `Mic Comparator`, `Mixer UI Controls`, `Lab: RT60, THD, Stereo`, `Calibration Workflow`, `Measurement Session`, `Themes`, `Custom Themes & Persistence`, `Package Metadata`, `Players & Teams`, `Monitor View`, `App Navigation & Layout`, `Game Settings`, `App Shell`, `Studio Meter Hooks`, `Generator & Latency`, `Spectrum & PNG Export`, `Party Sounds`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **What connects `electron-builder`, `@types/canvas-confetti`, `@types/node` to the rest of the system?**
  _40 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Audio Config & Profiles` be split into smaller, more focused modules?**
  _Cohesion score 0.05711849957374254 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `Build Config` to `Audio Config & Profiles`, `Game Modes`, `MIDI & Presets`, `System Health & Generators`, `Mixer Model & Tests`, `Lab: RT60, THD, Stereo`, `Level Analysis & Calibration`, `Calibration Workflow`, `Measurement Session`, `Take Analysis`, `FLAC Encoder`, `Package Metadata`, `Mixer Gain & EQ Math`, `Comparison Report`, `Weighting Filter Tests`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Should `Game Modes` be split into smaller, more focused modules?**
  _Cohesion score 0.07627118644067797 - nodes in this community are weakly interconnected._
- **Why does `AudioEngine (singleton)` connect `Architecture Docs: Audio & Studio` to `Architecture Docs: Game Core`, `Architecture Docs: App & Themes`, `Party Screens & Scoring UI`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Should `Mixer Engine Graph` be split into smaller, more focused modules?**
  _Cohesion score 0.06038961038961039 - nodes in this community are weakly interconnected._