import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../storage'

export function Certificate({ name, detail, onClose }: { name: string; detail: string; onClose: () => void }): JSX.Element {
  const { theme, data } = useStore()
  const birthday = data.settings.birthdayName
  const [msg, setMsg] = useState('')
  const date = new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })

  const savePdf = async (): Promise<void> => {
    const a = api()
    if (!a) return window.print()
    const path = await a.file.printPdf(`Certificado-${name}.pdf`)
    if (path) setMsg(`Guardado en ${path}`)
  }

  return (
    <div className="overlay certificate-overlay">
      <div className="certificate">
        {theme.images.logo && <img className="certificate-logo" src={theme.images.logo} alt="" />}
        <div className="certificate-ribbon">★ {theme.texts.appTitle} ★</div>
        <h1>{theme.texts.certificateTitle}</h1>
        <p className="certificate-pre">Se otorga a</p>
        <p className="certificate-name">{name}</p>
        <p className="certificate-body">{theme.texts.certificateBody}</p>
        <p className="certificate-detail">{detail}</p>
        {birthday && <p className="certificate-party">🎂 Fiesta de cumpleaños de {birthday}</p>}
        <div className="certificate-footer">
          <span>{date}</span>
          <span className="certificate-seal">🏅</span>
          <span>{theme.texts.winnerTitle}</span>
        </div>
      </div>
      <div className="cert-actions">
        <button className="btn" onClick={() => window.print()}>
          🖨️ Imprimir
        </button>
        <button className="btn" onClick={savePdf}>
          📄 Guardar PDF
        </button>
        <button className="btn ghost" onClick={onClose}>
          Cerrar
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
    </div>
  )
}
