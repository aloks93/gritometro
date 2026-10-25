import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isValidStudioCode } from '../../core/studio/unlock'
import { useStore } from '../store'
import { resolveLang, useStudioTranslation } from './i18n'
import './studio.css'

/** Access code gate of the standalone studio app; remembered on this PC once accepted */
export function UnlockScreen(): JSX.Element {
  const { data, update } = useStore()
  const root = useRef<HTMLDivElement>(null)
  useStudioTranslation(resolveLang(data.studio.prefs.language) === 'en', root)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    document.title = 'Gritómetro Studio'
  }, [])

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    const ok = await isValidStudioCode(code)
    setBusy(false)
    if (ok) {
      update('settings', (s) => ({ ...s, studioUnlocked: true }))
    } else {
      setError('Código incorrecto.')
      setCode('')
    }
  }

  return (
    <div className="studio st-unlock" ref={root}>
      <form className="st-panel st-unlock-card" onSubmit={submit}>
        <div className="st-brand">
          <span className="st-logo" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <b>Gritómetro</b> <span>Studio</span>
        </div>
        <p className="st-muted">Introduce el código de acceso para usar la aplicación.</p>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Código"
          value={code}
          onChange={(e) => {
            setCode(e.target.value)
            setError('')
          }}
        />
        {error && <p className="st-error st-small">{error}</p>}
        <button className="st-btn primary" type="submit" disabled={busy || code.trim() === ''}>
          Entrar
        </button>
      </form>
    </div>
  )
}
