# Graph Report - src  (2026-10-24)

## Corpus Check
- Corpus is ~23,613 words - fits in a single context window. You may not need a graph.

## Summary
- 334 nodes · 1001 edges · 8 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Themes & Persisted Data
- App Shell & UI Screens
- Game Mode Contract
- Audio Engine & Capture
- Studio Analysis
- Audio Config & Calibration
- Players & Teams
- Electron Main Process

## God Nodes (most connected - your core abstractions)
1. `useStore()` - 38 edges
2. `GameScreen()` - 26 edges
3. `audioEngine` - 24 edges
4. `CompareView()` - 22 edges
5. `AudioScreen()` - 17 edges
6. `CustomizeScreen()` - 17 edges
7. `Shell()` - 16 edges
8. `api()` - 15 edges
9. `Screen()` - 13 edges
10. `MonitorView()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `Window` --references--> `GritometroApi`  [EXTRACTED]
  renderer/src/ui/storage.ts → preload/index.ts
- `Shell()` --calls--> `AudioScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/AudioScreen.tsx
- `Shell()` --calls--> `CustomizeScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/CustomizeScreen.tsx
- `Shell()` --calls--> `ModesScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/ModesScreen.tsx
- `Shell()` --calls--> `PlayersScreen()`  [EXTRACTED]
  renderer/src/App.tsx → renderer/src/ui/screens/PlayersScreen.tsx

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "Themes & Persisted Data"
Cohesion: 0.06
Nodes (51): AudioSettings, defaultAudioSettings(), Player, defaultStudio(), StudioData, arcoirisTheme, clasicoTheme, DoorReveal() (+43 more)

### Community 1 - "App Shell & UI Screens"
Cohesion: 0.10
Nodes (37): App(), Shell(), useAudioBoot(), useThemeVars(), effectiveProfile(), normalizeLevel(), ScoreResult, SilenceWatcher (+29 more)

### Community 2 - "Game Mode Contract"
Cohesion: 0.08
Nodes (30): AnyGameMode, ConfigField, fmtPoints(), fmtSeconds(), GameContext, GameMode, ModeView, playerName() (+22 more)

### Community 3 - "Audio Engine & Capture"
Cohesion: 0.08
Nodes (22): Ballistics, audioEngine, describeError(), EngineState, EngineStatus, ReadingListener, StateListener, analyzeFrame() (+14 more)

### Community 4 - "Studio Analysis"
Cohesion: 0.12
Nodes (31): BAND_CENTERS, bandCurve(), bandShares(), binHz(), clamp(), dbToPower(), encodeWav(), matchGain() (+23 more)

### Community 5 - "Audio Config & Calibration"
Cohesion: 0.15
Nodes (26): activeProfile(), AudioProfile, createProfile(), isVirtualDevice(), LatencyHint, VIRTUAL_PATTERNS, noiseFloorFrom(), MIN_DB (+18 more)

### Community 6 - "Players & Teams"
Cohesion: 0.17
Nodes (22): ctxOf(), autoTeams(), AvatarSpec, createPlayer(), handicapFor(), HandicapRule, randomAvatar(), Team (+14 more)

### Community 7 - "Electron Main Process"
Cohesion: 0.22
Nodes (9): setupIpc(), dataDir(), dataPath(), fileFor(), readKey(), writeKey(), api, GritometroApi (+1 more)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `audioEngine` connect `Audio Engine & Capture` to `App Shell & UI Screens`, `Studio Analysis`, `Audio Config & Calibration`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `GameScreen()` (e.g. with `.push()` and `.survivedMs()`) actually correct?**
  _`GameScreen()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `Themes & Persisted Data` be split into smaller, more focused modules?**
  _Cohesion score 0.06144393241167435 - nodes in this community are weakly interconnected._
- **Why does `useStore()` connect `App Shell & UI Screens` to `Themes & Persisted Data`, `Studio Analysis`, `Audio Config & Calibration`, `Players & Teams`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Should `App Shell & UI Screens` be split into smaller, more focused modules?**
  _Cohesion score 0.09643483343074226 - nodes in this community are weakly interconnected._
- **Should `Game Mode Contract` be split into smaller, more focused modules?**
  _Cohesion score 0.07767722473604827 - nodes in this community are weakly interconnected._
- **Should `Audio Engine & Capture` be split into smaller, more focused modules?**
  _Cohesion score 0.08416389811738649 - nodes in this community are weakly interconnected._