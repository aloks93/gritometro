import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { saveFile } from '../storage'

/** Webcam snapshot of the winner with a themed banner, saved as PNG */
export function WinnerPhoto({ name, detail, onClose }: { name: string; detail: string; onClose: () => void }): JSX.Element {
  const { theme, data } = useStore()
  const birthday = data.settings.birthdayName
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [shot, setShot] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let stream: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({ video: { width: 1280, height: 720 }, audio: false })
      .then((s) => {
        stream = s
        if (video.current) video.current.srcObject = s
      })
      .catch(() => setError('No se encontró una cámara web.'))
    return () => stream?.getTracks().forEach((t) => t.stop())
  }, [])

  const capture = (): void => {
    const v = video.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    const g = canvas.getContext('2d')!
    // Mirror like a selfie
    g.save()
    g.translate(canvas.width, 0)
    g.scale(-1, 1)
    g.drawImage(v, 0, 0)
    g.restore()
    const bannerH = canvas.height * 0.2
    g.fillStyle = theme.tokens.bg
    g.globalAlpha = 0.85
    g.fillRect(0, canvas.height - bannerH, canvas.width, bannerH)
    g.globalAlpha = 1
    g.fillStyle = theme.tokens.primary
    g.font = `${bannerH * 0.38}px ${theme.tokens.fontDisplay}`
    g.textAlign = 'center'
    g.fillText(`${theme.texts.winnerTitle}: ${name}`, canvas.width / 2, canvas.height - bannerH * 0.5)
    g.fillStyle = theme.tokens.text
    g.font = `${bannerH * 0.2}px ${theme.tokens.fontBody}`
    g.fillText(`${detail} · ${birthday ? `Cumpleaños de ${birthday}` : theme.texts.appTitle}`, canvas.width / 2, canvas.height - bannerH * 0.18)
    setShot(canvas.toDataURL('image/png'))
  }

  const download = async (): Promise<void> => {
    if (!shot) return
    const path = await saveFile(`Foto-${name}.png`, shot.split(',')[1], 'base64')
    if (path) setMsg(`Guardada en ${path}`)
  }

  return (
    <div className="overlay">
      <div className="panel photo-panel">
        <h2 className="panel-title">📸 Foto del ganador</h2>
        {error && <p className="error">{error}</p>}
        {shot && <img className="photo-preview" src={shot} alt="Foto del ganador" />}
        {/* Keep the video mounted so "Repetir" doesn't lose the camera stream */}
        <video ref={video} className="photo-preview mirror" autoPlay muted playsInline hidden={!!shot || !!error} />
        <div className="row">
          {!shot && !error && (
            <button className="btn primary" onClick={capture}>
              Tomar foto
            </button>
          )}
          {shot && (
            <>
              <button className="btn primary" onClick={download}>
                Guardar PNG
              </button>
              <button className="btn" onClick={() => setShot(null)}>
                Repetir
              </button>
            </>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </div>
  )
}
