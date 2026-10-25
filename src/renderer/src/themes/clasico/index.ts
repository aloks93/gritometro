import type { Theme } from '../Theme'

export const clasicoTheme: Theme = {
  id: 'clasico',
  name: 'Clásico',
  description: 'Limpio y oscuro, con medidor de barras tipo estudio.',
  tokens: {
    bg: '#14121f',
    bgAlt: '#221d36',
    surface: 'rgba(255,255,255,0.06)',
    surfaceBorder: 'rgba(255,255,255,0.12)',
    text: '#f3f1ff',
    textMuted: '#a7a1c2',
    primary: '#7c5cff',
    primaryText: '#ffffff',
    accent: '#22d3ee',
    success: '#4ade80',
    danger: '#f43f5e',
    meterLow: '#22d3ee',
    meterMid: '#facc15',
    meterHigh: '#f43f5e',
    fontDisplay: "'Nunito', 'Segoe UI', sans-serif",
    fontBody: "'Nunito', 'Segoe UI', sans-serif",
    radius: '14px'
  },
  texts: {
    appTitle: 'Gritómetro',
    subtitle: '¿Quién grita más fuerte?',
    screamCta: '¡GRITA!',
    silenceCta: 'Silencio total...',
    sustainCta: '¡Aaaaah! ¡No pares!',
    getReady: 'Prepárate',
    resultTitle: 'Resultado',
    newRecord: '¡Nuevo récord!',
    winnerTitle: 'Campeón del grito',
    certificateTitle: 'Certificado de Campeón',
    certificateBody: 'por demostrar la voz más poderosa de la fiesta',
    levels: [
      { min: 0, label: 'Murmullo' },
      { min: 20, label: 'Voz normal' },
      { min: 40, label: 'Fuerte' },
      { min: 60, label: 'Muy fuerte' },
      { min: 80, label: '¡Ensordecedor!' },
      { min: 95, label: '¡LEGENDARIO!' }
    ]
  },
  components: {},
  soundStyle: 'arcade',
  images: {},
  sounds: {}
}
