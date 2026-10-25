---
name: empaquetar
description: Compila el Gritómetro como instalador y ejecutable portable de Windows (.exe) con electron-builder y verifica el resultado. Úsalo cuando el usuario quiera "el .exe", instalarlo en otra PC o llevarlo a la fiesta.
---

# Empaquetar para Windows

Configuración: `electron-builder.yml` (targets `nsis` = instalador y `portable`), salida en `dist/`.

1. `npm test` y `npm run typecheck` deben pasar antes de empaquetar.
2. `npm run build:win` (la primera vez tarda: descarga binarios de Electron/NSIS).
3. Resultado en `dist/`:
   - `Gritometro-<versión>-x64.exe` → instalador.
   - `Gritometro-<versión>-portable.exe` → no requiere instalación (ideal para llevar en USB a la fiesta).
4. Prueba el portable: ábrelo, verifica que usa el micrófono, juega un turno, ciérralo y vuelve a abrirlo para confirmar que guarda los récords.
5. Avisa al usuario: Windows SmartScreen mostrará "Editor desconocido" porque el ejecutable no está firmado → "Más información" → "Ejecutar de todas formas".
6. Para subir la versión, cambia `version` en `package.json`.

## Errores comunes
- Falta de permiso para crear symlinks al extraer `winCodeSign`: activar el Modo de desarrollador de Windows (o usar una terminal de administrador) y reintentar.
- Antivirus bloqueando `dist/`: excluir la carpeta temporalmente.
- Icono propio: coloca `build/icon.ico` (256×256) y vuelve a empaquetar.
