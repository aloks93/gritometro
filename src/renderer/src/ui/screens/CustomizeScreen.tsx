import { useState } from 'react'
import { FONT_OPTIONS, TOKEN_LABELS, type CustomTheme, type ThemeTexts, type ThemeTokens } from '../../themes/Theme'
import { builtInThemes, customFromBuiltIn, getBuiltIn, isCustomTheme, resolveTheme } from '../../themes/registry'
import { Field, Panel, Screen } from '../components/Layout'
import type { Navigate } from '../nav'
import { openTextFile, readFileAsDataUrl, saveFile } from '../storage'
import { useStore } from '../store'

const TEXT_FIELDS: { key: keyof Omit<ThemeTexts, 'levels'>; label: string }[] = [
  { key: 'appTitle', label: 'Título (p. ej. "Gritómetro de Sofi")' },
  { key: 'subtitle', label: 'Subtítulo' },
  { key: 'screamCta', label: 'Botón / mensaje para gritar' },
  { key: 'getReady', label: 'Mensaje antes del turno' },
  { key: 'silenceCta', label: 'Mensaje del reto del silencio' },
  { key: 'resultTitle', label: 'Título del resultado' },
  { key: 'newRecord', label: 'Mensaje de nuevo récord' },
  { key: 'winnerTitle', label: 'Título del ganador' },
  { key: 'certificateTitle', label: 'Título del certificado' },
  { key: 'certificateBody', label: 'Texto del certificado' }
]

export function CustomizeScreen({ navigate }: { navigate: Navigate }): JSX.Element {
  const { data, update, theme } = useStore()
  const [msg, setMsg] = useState('')
  const custom = data.customThemes.find((t) => t.id === data.themeId)
  const all = [...builtInThemes, ...data.customThemes.map((c) => resolveTheme(c.id, data.customThemes))]

  const edit = (fn: (c: CustomTheme) => CustomTheme): void =>
    update('customThemes', (list) => list.map((c) => (c.id === data.themeId ? fn(c) : c)))

  const setToken = (key: keyof ThemeTokens, value: string): void => edit((c) => ({ ...c, tokens: { ...c.tokens, [key]: value } }))
  const setText = (key: keyof Omit<ThemeTexts, 'levels'>, value: string): void => edit((c) => ({ ...c, texts: { ...c.texts, [key]: value } }))

  const makeCopy = (): void => {
    const base = custom ? { ...custom, id: `custom-${Date.now().toString(36)}`, name: `${custom.name} (copia)` } : customFromBuiltIn(theme, `${theme.name} (mío)`)
    update('customThemes', (list) => [...list, base])
    update('themeId', base.id)
  }

  const remove = (): void => {
    if (!custom || !confirm(`¿Eliminar el tema "${custom.name}"?`)) return
    update('customThemes', (list) => list.filter((c) => c.id !== custom.id))
    update('themeId', custom.baseId)
  }

  const upload = async (file: File | undefined, apply: (url: string) => void): Promise<void> => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) return setMsg('El archivo es muy grande (máx. 8 MB).')
    apply(await readFileAsDataUrl(file))
  }

  const exportTheme = async (): Promise<void> => {
    if (!custom) return
    const path = await saveFile(`tema-${custom.name}.json`, JSON.stringify(custom, null, 2))
    if (path) setMsg(`Tema exportado: ${path}`)
  }

  const importTheme = async (): Promise<void> => {
    const text = await openTextFile(['json'])
    if (!text) return
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isCustomTheme(parsed)) throw new Error()
      // Older/hand-written files may lack some sections
      const imported: CustomTheme = {
        ...parsed,
        images: parsed.images ?? {},
        sounds: parsed.sounds ?? {},
        texts: parsed.texts ?? {},
        id: `custom-${Date.now().toString(36)}`
      }
      update('customThemes', (list) => [...list, imported])
      update('themeId', imported.id)
      setMsg(`Tema "${imported.name}" importado.`)
    } catch {
      setMsg('Ese archivo no es un tema válido del Gritómetro.')
    }
  }

  return (
    <Screen
      title="🎨 Personalizar"
      onBack={() => navigate({ name: 'home' })}
      actions={
        <button className="btn" onClick={importTheme}>
          Importar tema
        </button>
      }
    >
      <div className="theme-grid">
        {all.map((t) => (
          <button key={t.id} className={`theme-card ${t.id === data.themeId ? 'selected' : ''}`} onClick={() => update('themeId', t.id)}>
            <div className="theme-swatch" style={{ background: t.tokens.bg }}>
              <span style={{ background: t.tokens.primary }} />
              <span style={{ background: t.tokens.accent }} />
              <span style={{ background: t.tokens.success }} />
            </div>
            <strong>{t.name}</strong>
            <small>{t.id.startsWith('custom-') ? `Basado en ${getBuiltIn(data.customThemes.find((c) => c.id === t.id)!.baseId).name}` : t.description}</small>
          </button>
        ))}
      </div>
      {msg && <p className="muted">{msg}</p>}

      {!custom ? (
        <Panel title={`Tema: ${theme.name}`}>
          <p>Los temas incluidos no se modifican directamente. Crea tu copia y cambia colores, textos, fuentes, imágenes y sonidos.</p>
          <button className="btn primary" onClick={makeCopy}>
            ✏️ Crear copia personalizable
          </button>
        </Panel>
      ) : (
        <>
          <Panel title="Tema personalizado">
            <div className="row">
              <Field label="Nombre del tema">
                <input value={custom.name} onChange={(e) => edit((c) => ({ ...c, name: e.target.value }))} />
              </Field>
              <div className="row grow end">
                <button className="btn" onClick={makeCopy}>
                  Duplicar
                </button>
                <button className="btn" onClick={exportTheme}>
                  Exportar
                </button>
                <button className="btn danger" onClick={remove}>
                  Eliminar
                </button>
              </div>
            </div>
          </Panel>

          <div className="two-col">
            <Panel title="Colores y fuentes">
              <div className="color-grid">
                {(Object.keys(TOKEN_LABELS) as (keyof ThemeTokens)[]).map((key) => (
                  <label key={key} className="color-field">
                    <input type="color" value={toHex(theme.tokens[key])} onChange={(e) => setToken(key, e.target.value)} />
                    <span>{TOKEN_LABELS[key]}</span>
                  </label>
                ))}
              </div>
              <Field label="Fuente de títulos">
                <select value={theme.tokens.fontDisplay} onChange={(e) => setToken('fontDisplay', e.target.value)}>
                  {withCurrent(theme.tokens.fontDisplay).map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Fuente de texto">
                <select value={theme.tokens.fontBody} onChange={(e) => setToken('fontBody', e.target.value)}>
                  {withCurrent(theme.tokens.fontBody).map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Redondez de esquinas">
                <input
                  type="range"
                  min={0}
                  max={32}
                  value={parseInt(theme.tokens.radius)}
                  onChange={(e) => setToken('radius', `${e.target.value}px`)}
                />
              </Field>
              <button className="btn small ghost" onClick={() => edit((c) => ({ ...c, tokens: {} }))}>
                Restaurar colores del tema base
              </button>
            </Panel>

            <Panel title="Imágenes y sonidos">
              <MediaField label="Imagen de fondo" value={custom.images.background} kind="image" onPick={(f) => upload(f, (url) => edit((c) => ({ ...c, images: { ...c.images, background: url } })))} onClear={() => edit((c) => ({ ...c, images: { ...c.images, background: undefined } }))} />
              <MediaField label="Logo" value={custom.images.logo} kind="image" onPick={(f) => upload(f, (url) => edit((c) => ({ ...c, images: { ...c.images, logo: url } })))} onClear={() => edit((c) => ({ ...c, images: { ...c.images, logo: undefined } }))} />
              <MediaField label="Sonido de ganador" value={custom.sounds.win} kind="audio" onPick={(f) => upload(f, (url) => edit((c) => ({ ...c, sounds: { ...c.sounds, win: url } })))} onClear={() => edit((c) => ({ ...c, sounds: { ...c.sounds, win: undefined } }))} />
              <MediaField label="Sonido de nuevo récord" value={custom.sounds.record} kind="audio" onPick={(f) => upload(f, (url) => edit((c) => ({ ...c, sounds: { ...c.sounds, record: url } })))} onClear={() => edit((c) => ({ ...c, sounds: { ...c.sounds, record: undefined } }))} />
              <p className="field-hint">Si no subes sonidos se usan los efectos del tema base. Las imágenes se guardan dentro del tema.</p>
            </Panel>
          </div>

          <Panel title="Textos">
            <div className="text-grid">
              {TEXT_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <input value={theme.texts[f.key]} onChange={(e) => setText(f.key, e.target.value)} />
                </Field>
              ))}
            </div>
          </Panel>
        </>
      )}
    </Screen>
  )
}

function MediaField({
  label,
  value,
  kind,
  onPick,
  onClear
}: {
  label: string
  value?: string
  kind: 'image' | 'audio'
  onPick: (f?: File) => void
  onClear: () => void
}): JSX.Element {
  return (
    <div className="media-field">
      <span className="field-label">{label}</span>
      <div className="row">
        {value && kind === 'image' && <img src={value} alt="" className="media-thumb" />}
        {value && kind === 'audio' && <audio src={value} controls className="media-audio" />}
        <label className="btn small">
          {value ? 'Cambiar' : 'Subir'}
          <input type="file" hidden accept={kind === 'image' ? 'image/*' : 'audio/*'} onChange={(e) => onPick(e.target.files?.[0])} />
        </label>
        {value && (
          <button className="btn small ghost" onClick={onClear}>
            Quitar
          </button>
        )}
      </div>
    </div>
  )
}

function withCurrent(value: string): { label: string; value: string }[] {
  return FONT_OPTIONS.some((f) => f.value === value) ? FONT_OPTIONS : [{ label: 'Actual', value }, ...FONT_OPTIONS]
}

function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color
  if (/^#[0-9a-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map((c) => c + c).join('')
  const m = color.match(/\d+/g)
  if (m && m.length >= 3) return '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  return '#000000'
}
