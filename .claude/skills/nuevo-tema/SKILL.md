---
name: nuevo-tema
description: Crea un nuevo tema visual para el Gritómetro (colores, fuentes, textos y componentes opcionales como medidor, fondo y animación de resultado). Úsalo cuando el usuario pida un tema/interfaz nueva (p. ej. "tema de princesas", "tema espacial", "tema de dinosaurios").
---

# Crear un tema nuevo

Contrato: `src/renderer/src/themes/Theme.ts` (`Theme`, `ThemeTokens`, `ThemeTexts`, `MeterProps`, `RevealProps`).
Ejemplos: `themes/clasico` (solo tokens), `themes/arcoiris` (deriva de otro tema), `themes/fabrica-monstruos` (componentes propios + CSS).

## Pasos
1. Pregunta (si no está claro) el concepto, la paleta y si quiere medidor/fondo propios o basta con colores.
2. Crea `src/renderer/src/themes/<id-kebab>/index.ts` exportando `export const <camel>Theme: Theme`.
   - `tokens`: todos los campos de `ThemeTokens`. Colores en `#rrggbb` (el editor de color solo entiende hex) salvo `surface`/`surfaceBorder`, que pueden ser `rgba(...)`.
   - Revisa el contraste de `text` sobre `bg` y de `primaryText` sobre `primary` (≥ 4.5:1).
   - `texts`: todos los textos en español, con humor infantil acorde al tema. `levels`: 6–7 niveles con `min` ascendente desde 0.
   - `soundStyle`: `'arcade'` o `'factory'` (o añade uno nuevo en `ui/sound.ts`).
   - Fuentes: solo las incluidas offline (`'Luckiest Guy'`, `'Nunito'`) o fuentes del sistema. Si necesitas otra, instala `@fontsource/<fuente>` e impórtala en `src/renderer/src/main.tsx` (la fiesta puede no tener internet).
3. Componentes opcionales (`components`):
   - `Meter` recibe `MeterProps` (`level` y `held` 0..1, `active`, `score`, `clipped`, `compact`). Debe verse bien grande y en `compact` (tanques de equipos). Usa `var(--c-…)` para los colores.
   - `Background`: `position: fixed; inset: 0; z-index: 0`, con `aria-hidden`.
   - `Reveal`: envuelve el resultado con una animación de entrada.
   - Estilos en `themes/<id>/<id>.css` importado desde `index.ts`; prefija las clases con el id del tema.
4. Registra el tema en `src/renderer/src/themes/registry.ts` (`builtInThemes`).
5. Arte siempre original: nada de logos, personajes ni marcas reales.
6. Verifica: `npm run typecheck`, `npm test` y abre la app (`npm run dev`) → Personalizar → elige el tema; revisa Inicio, un turno y el podio.
