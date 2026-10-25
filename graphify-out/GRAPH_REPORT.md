# Graph Report - src  (2026-10-24)

## Corpus Check
- Corpus is ~17,687 words - fits in a single context window. You may not need a graph.

## Summary
- 276 nodes · 809 edges · 10 communities (9 shown, 1 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Game Mode Contract
- Audio Engine Loop
- Built-in Themes
- App Shell & Players
- Game Screen & Scoring
- Settings & Persistence
- Audio Config & Devices
- Electron Main Process
- Sound Effects

## God Nodes (most connected - your core abstractions)
1. `useStore()` - 32 edges
2. `GameScreen()` - 26 edges
3. `audioEngine` - 19 edges
4. `CustomizeScreen()` - 17 edges
5. `Shell()` - 15 edges
6. `AudioScreen()` - 15 edges
7. `Screen()` - 13 edges
8. `api()` - 13 edges
9. `GameMode` - 11 edges
10. `Panel()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Window` --references--> `GritometroApi`  [EXTRACTED]
  renderer/src/ui/storage.ts → preload/index.ts
- `useAudioBoot()` --calls--> `effectiveProfile()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/core/audio/AudioConfig.ts
- `Shell()` --calls--> `AudioScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/AudioScreen.tsx
- `Shell()` --calls--> `CustomizeScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/CustomizeScreen.tsx
- `Shell()` --calls--> `GameScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/GameScreen.tsx

## Import Cycles
- None detected.

## Communities (10 total, 1 thin omitted)

### Community 0 - "Game Mode Contract"
Cohesion: 0.08
Nodes (27): AnyGameMode, ConfigField, fmtPoints(), fmtSeconds(), GameMode, ModeView, playerName(), Standing (+19 more)

### Community 1 - "Audio Engine Loop"
Cohesion: 0.09
Nodes (24): AudioProfile, audioEngine, describeError(), EngineState, EngineStatus, ReadingListener, StateListener, noiseFloorFrom() (+16 more)

### Community 2 - "Built-in Themes"
Cohesion: 0.09
Nodes (32): arcoirisTheme, clasicoTheme, DoorReveal(), DOORS, FactoryBackground(), fabricaMonstruosTheme, BUBBLES, ScreamTank() (+24 more)

### Community 3 - "App Shell & Players"
Cohesion: 0.14
Nodes (30): App(), Shell(), useAudioBoot(), useThemeVars(), GameContext, ctxOf(), autoTeams(), AvatarSpec (+22 more)

### Community 4 - "Game Screen & Scoring"
Cohesion: 0.14
Nodes (24): effectiveProfile(), normalizeLevel(), ScoreResult, SilenceWatcher, Turn, getMode(), levelLabel(), Certificate() (+16 more)

### Community 5 - "Settings & Persistence"
Cohesion: 0.17
Nodes (19): GritometroApi, AudioSettings, HandicapRule, defaultGameSettings(), GameSettings, CustomTheme, api(), load() (+11 more)

### Community 6 - "Audio Config & Devices"
Cohesion: 0.25
Nodes (13): activeProfile(), Ballistics, createProfile(), defaultAudioSettings(), isVirtualDevice(), LatencyHint, VIRTUAL_PATTERNS, InputDevice (+5 more)

### Community 7 - "Electron Main Process"
Cohesion: 0.27
Nodes (7): setupIpc(), dataDir(), dataPath(), fileFor(), readKey(), writeKey(), api

### Community 8 - "Sound Effects"
Cohesion: 0.32
Nodes (7): SoundStyle, ac(), makeSounds(), playUrl(), Sounds, synth, tone()

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `audioEngine` connect `Audio Engine Loop` to `App Shell & Players`, `Game Screen & Scoring`, `Audio Config & Devices`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `GameScreen()` (e.g. with `.push()` and `.survivedMs()`) actually correct?**
  _`GameScreen()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `Game Mode Contract` be split into smaller, more focused modules?**
  _Cohesion score 0.08421985815602837 - nodes in this community are weakly interconnected._
- **Why does `useStore()` connect `Game Screen & Scoring` to `Built-in Themes`, `App Shell & Players`, `Settings & Persistence`, `Audio Config & Devices`, `Sound Effects`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Should `Audio Engine Loop` be split into smaller, more focused modules?**
  _Cohesion score 0.09080841638981174 - nodes in this community are weakly interconnected._
- **Should `Built-in Themes` be split into smaller, more focused modules?**
  _Cohesion score 0.09175377468060394 - nodes in this community are weakly interconnected._
- **Should `App Shell & Players` be split into smaller, more focused modules?**
  _Cohesion score 0.14304993252361672 - nodes in this community are weakly interconnected._