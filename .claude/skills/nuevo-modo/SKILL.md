---
name: nuevo-modo
description: Agrega un nuevo reto/modo de juego al Gritómetro implementando el contrato GameMode, con su test. Úsalo cuando el usuario pida un juego nuevo (p. ej. "rey de la colina", "grito más largo", "relevos", "eliminación").
---

# Crear un modo de juego

Contrato: `src/renderer/src/core/game/GameMode.ts`. Los modos son **puros** (estado in → estado nuevo out), sin React ni audio.
Ejemplos: `modes/attempts.ts` (fábrica reutilizable "N intentos, vale el mejor"), `modes/duel.ts`, `modes/tournament.ts` (con `view` de llaves), `modes/teamTank.ts` (equipos).

## Pasos
1. Define reglas claras: quién grita en cada turno, cuándo termina, cómo se ordena la tabla, desempates.
2. Crea `src/renderer/src/core/game/modes/<id>.ts`:
   - `id` único en kebab-case, `name`, `description` (español, divertido), `emoji`.
   - `minPlayers`/`maxPlayers`; `usesTeams` si usa `ctx.teams`.
   - `turnKind`: `'scream'` (valor = puntos 0–100) o `'silence'` (valor = segundos).
   - `configFields` numéricos con `min`/`max` + `defaultConfig` (booleanos como 0/1).
   - `nextTurn` devuelve `null` cuando el juego terminó; `label` opcional para el contexto ("Ronda 2").
   - `applyResult` nunca muta: copia objetos/arrays.
   - `standings` ordenado del mejor al peor, con `display` legible.
   - `view` opcional (`ModeView`): reutiliza `bracket`, `tanks` o `duel`; si necesitas otro tipo, añádelo a `ModeView` y renderízalo en `ui/components/ModeViews.tsx`.
   - Si es "todos tienen N intentos", usa `createAttemptsMode` en vez de reescribirlo.
3. Regístralo en `core/game/registry.ts`.
4. Añade tests en `core/game/modes.test.ts` con el helper `play(...)`: que termine, número de turnos esperado, ganador correcto, empates, casos borde (1 jugador, cantidad impar).
5. Si el modo necesita un tipo de turno nuevo (ni grito ni silencio), implementa la medición en `ui/screens/GameScreen.tsx` (ver `runScream`/`runSilence`) y la lógica pura en `core/audio/`.
6. Verifica: `npm test`, `npm run typecheck` y juega una partida con `npm run dev`.
