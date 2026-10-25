# Graph Report - Gritometro  (2026-10-25)

## Corpus Check
- 108 files · ~72,195 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 5 file(s) not represented in the graph (top: .css 4, (none) 1)

## Summary
- 904 nodes · 2492 edges · 31 communities (24 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 36 edges (avg confidence: 0.86)
- Token cost: 74,657 input · 0 output

## Community Hubs (Navigation)
- Studio Take Analysis
- App Shell & Audio Config
- Studio UI Meters & Loudness
- Themes & Preload API
- DSP Filters & Generators
- Game Modes
- Mixer Model & Tests
- Project Docs & Skills
- Mixer UI Controls
- Lab: RT60, THD, Stereo
- Mixer Engine Graph
- Mixer Engine Runtime
- Audio Engine Output
- Package Metadata
- TypeScript Config
- Level Analysis & Calibration
- Electron Main & Storage
- Dev Dependencies
- Audio Engine Types
- Scream Scoring
- NPM Scripts
- PCM Tap & Capture
- Build Config
- Runtime Dependencies
- Bus Tap Worklet
- Sustain Watcher
- Strip Gate Worklet
- Build Script Allowlist
- Studio Build Script
- PCM Tap Worklet

## God Nodes (most connected - your core abstractions)
1. `useStore()` - 50 edges
2. `audioEngine` - 44 edges
3. `CompareView()` - 36 edges
4. `react` - 33 edges
5. `mixerEngine` - 30 edges
6. `GameScreen()` - 28 edges
7. `RecorderView()` - 28 edges
8. `MixerView()` - 27 edges
9. `MonitorView()` - 23 edges
10. `useEngineState()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `<userData>/data/*.json persisted data` --shares_data_with--> `Persistence pipeline (store -> storage -> IPC -> data/<key>.json)`  [INFERRED]
  .claude/skills/checklist-fiesta/SKILL.md → CLAUDE.md
- `Simple vs advanced audio mode (effectiveProfile)` --conceptually_related_to--> `Mic owned only by audioEngine singleton`  [INFERRED]
  .claude/skills/configurar-audio/SKILL.md → CLAUDE.md
- `electron-builder.yml (party packaging)` --implements--> `Portable Windows .exe`  [INFERRED]
  electron-builder.yml → .claude/skills/empaquetar/SKILL.md
- `Skill: modo-estudio` --references--> `electron-builder.studio.yml (Gritometro Studio packaging)`  [INFERRED]
  .claude/skills/modo-estudio/SKILL.md → electron-builder.studio.yml
- `core/ must stay framework-free` --rationale_for--> `technicalScore weights (SNR 55, level 15, clipping 15, tonal 15)`  [INFERRED]
  CLAUDE.md → .claude/skills/modo-estudio/SKILL.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Party preparation workflow (package, audio setup, score tuning)** — _claude_skills_checklist_fiesta_skill, _claude_skills_empaquetar_skill, _claude_skills_configurar_audio_skill, _claude_skills_ajustar_puntaje_skill [EXTRACTED 1.00]
- **Two editions from one codebase (party + studio)** — claude_party_edition, claude_studio_edition, electron_builder, electron_builder_studio, _claude_skills_modo_estudio_skill_studio_release [EXTRACTED 1.00]
- **Scream scoring inputs** — _claude_skills_ajustar_puntaje_skill_scream_score_formula, _claude_skills_ajustar_puntaje_skill_sustained_peak_anti_cheat, _claude_skills_ajustar_puntaje_skill_age_handicap, _claude_skills_ajustar_puntaje_skill_difficulty_rangedb, _claude_skills_ajustar_puntaje_skill_noise_floor_calibration [EXTRACTED 1.00]

## Communities (31 total, 7 thin omitted)

### Community 0 - "Studio Take Analysis"
Cohesion: 0.05
Nodes (84): aWeightingDb(), aWeightingOffset(), BAND_CENTERS, bandCurve(), bandShares(), binHz(), clamp(), curveDifference() (+76 more)

### Community 1 - "App Shell & Audio Config"
Cohesion: 0.06
Nodes (71): App(), Shell(), useAudioBoot(), useThemeVars(), activeProfile(), AudioProfile, AudioSettings, createProfile() (+63 more)

### Community 2 - "Studio UI Meters & Loudness"
Cohesion: 0.08
Nodes (64): react, MIN_DB, noteName(), LoudnessReading, round1(), SlmReading, SoundLevelMeter, detectPitch() (+56 more)

### Community 3 - "Themes & Preload API"
Cohesion: 0.05
Nodes (60): api, GritometroApi, arcoirisTheme, clasicoTheme, DoorReveal(), DOORS, FactoryBackground(), fabricaMonstruosTheme (+52 more)

### Community 4 - "DSP Filters & Generators"
Cohesion: 0.06
Nodes (43): joinChunks(), eqSections(), ampToDb(), aWeighting(), Biquad, clickBurst(), cWeighting(), digitalPole() (+35 more)

### Community 5 - "Game Modes"
Cohesion: 0.08
Nodes (35): AnyGameMode, ConfigField, fmtPoints(), fmtSeconds(), GameContext, GameMode, playerName(), Standing (+27 more)

### Community 6 - "Mixer Model & Tests"
Cohesion: 0.08
Nodes (49): vitest, applyMidi(), applyPreset(), applyProcessing(), BusKind, createStrip(), defaultBuses(), defaultEqBands() (+41 more)

### Community 7 - "Project Docs & Skills"
Cohesion: 0.06
Nodes (40): Skill: ajustar-puntaje, Age bonus multiplier, Difficulty (rangeDb), Noise floor calibration (noiseFloorDb), Skill: checklist-fiesta, Suggested challenge order (Ranking, Torneo, Tanque, Silencio), <userData>/data/*.json persisted data, Skill: configurar-audio (+32 more)

### Community 8 - "Mixer UI Controls"
Cohesion: 0.08
Nodes (35): autoTrim(), describeMidiKey(), EqBand, FADER_MIN, faderToPos(), MAX_STRIPS, MidiTargetKind, Monitor (+27 more)

### Community 9 - "Lab: RT60, THD, Stereo"
Cohesion: 0.13
Nodes (32): decay(), spectrum(), energyEnvelope(), fitSlope(), measureRt60(), Rt60Result, rt60Verdict(), blackmanHarris() (+24 more)

### Community 10 - "Mixer Engine Graph"
Cohesion: 0.08
Nodes (27): analyser(), BusLevel, BusNodes, chain(), ChannelLevel, join(), MixerState, MixerStatus (+19 more)

### Community 11 - "Mixer Engine Runtime"
Cohesion: 0.11
Nodes (7): describe(), mixerEngine, openSource(), structureKey(), toDb(), duckStep(), MixerConfig

### Community 12 - "Audio Engine Output"
Cohesion: 0.15
Nodes (3): audioEngine, describeError(), ExternalSource

### Community 13 - "Package Metadata"
Cohesion: 0.11
Nodes (17): author, description, main, name, private, version, canvas-confetti, electron-builder (+9 more)

### Community 14 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, baseUrl, esModuleInterop, isolatedModules, jsx, lib, module, moduleResolution (+9 more)

### Community 15 - "Level Analysis & Calibration"
Cohesion: 0.22
Nodes (10): Ballistics, noiseFloorFrom(), analyzeFrame(), BALLISTICS, CLIP_THRESHOLD, peak(), rms(), smooth() (+2 more)

### Community 16 - "Electron Main & Storage"
Cohesion: 0.30
Nodes (9): electron, setupIpc(), dataDir(), dataPath(), fileFor(), queues, readKey(), writeKey() (+1 more)

### Community 17 - "Dev Dependencies"
Cohesion: 0.17
Nodes (12): devDependencies, electron, electron-builder, electron-vite, @types/canvas-confetti, @types/node, @types/react, @types/react-dom (+4 more)

### Community 18 - "Audio Engine Types"
Cohesion: 0.20
Nodes (9): EngineState, EngineStatus, PcmListener, PcmTap, ReadingListener, SinkContext, StateListener, workletLoaded (+1 more)

### Community 19 - "Scream Scoring"
Cohesion: 0.27
Nodes (6): above(), DEFAULT_SCORE_OPTIONS, ScoreOptions, scoreScream(), SilenceWatcher, sustainedPeak()

### Community 20 - "NPM Scripts"
Cohesion: 0.25
Nodes (8): scripts, build, build:studio, build:win, dev, preview, test, typecheck

### Community 22 - "Build Config"
Cohesion: 0.33
Nodes (3): define, electron-vite, @vitejs/plugin-react

### Community 23 - "Runtime Dependencies"
Cohesion: 0.33
Nodes (6): dependencies, canvas-confetti, @fontsource/luckiest-guy, @fontsource/nunito, react, react-dom

### Community 27 - "Build Script Allowlist"
Cohesion: 0.50
Nodes (4): allowScripts, electron@36.9.5, electron-winstaller@5.4.0, esbuild@0.25.12

## Knowledge Gaps
- **15 isolated node(s):** `@types/canvas-confetti`, `@types/node`, `@types/react`, `@types/react-dom`, `electron-builder` (+10 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 250 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Studio UI Meters & Loudness` to `Studio Take Analysis`, `App Shell & Audio Config`, `Themes & Preload API`, `DSP Filters & Generators`, `Mixer UI Controls`, `Lab: RT60, THD, Stereo`, `Package Metadata`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **What connects `@types/canvas-confetti`, `@types/node`, `@types/react` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Studio Take Analysis` be split into smaller, more focused modules?**
  _Cohesion score 0.05049442457395329 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `Mixer Model & Tests` to `Studio Take Analysis`, `DSP Filters & Generators`, `Game Modes`, `Lab: RT60, THD, Stereo`, `Package Metadata`, `Level Analysis & Calibration`, `Build Config`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Should `App Shell & Audio Config` be split into smaller, more focused modules?**
  _Cohesion score 0.05925417524593914 - nodes in this community are weakly interconnected._
- **Why does `audioEngine` connect `Audio Engine Output` to `Studio Take Analysis`, `App Shell & Audio Config`, `Studio UI Meters & Loudness`, `DSP Filters & Generators`, `Lab: RT60, THD, Stereo`, `Audio Engine Types`, `PCM Tap & Capture`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Should `Studio UI Meters & Loudness` be split into smaller, more focused modules?**
  _Cohesion score 0.07825507825507826 - nodes in this community are weakly interconnected._