import type { Theme } from '../Theme'
import { clasicoTheme } from '../clasico'

// Light pastel theme built only from tokens + texts: proof that a theme needs no custom components
export const arcoirisTheme: Theme = {
  ...clasicoTheme,
  id: 'arcoiris',
  name: 'Arcoíris',
  description: 'Claro y pastel, ideal para fiestas de día.',
  tokens: {
    bg: '#fff4fb',
    bgAlt: '#e9f3ff',
    surface: 'rgba(255,255,255,0.75)',
    surfaceBorder: 'rgba(120,80,160,0.18)',
    text: '#3b2554',
    textMuted: '#7a6690',
    primary: '#ff5fa2',
    primaryText: '#ffffff',
    accent: '#7c83fd',
    success: '#2bb673',
    danger: '#e5484d',
    meterLow: '#7c83fd',
    meterMid: '#ffb84c',
    meterHigh: '#ff5fa2',
    fontDisplay: "'Luckiest Guy', 'Impact', sans-serif",
    fontBody: "'Nunito', 'Segoe UI', sans-serif",
    radius: '22px'
  },
  texts: {
    ...clasicoTheme.texts,
    subtitle: '¡Grita con todos los colores!',
    certificateTitle: 'Certificado Arcoíris',
    levels: [
      { min: 0, label: 'Susurro de nube' },
      { min: 20, label: 'Gotita de lluvia' },
      { min: 40, label: 'Trueno chiquito' },
      { min: 60, label: 'Tormenta' },
      { min: 80, label: '¡Huracán de colores!' },
      { min: 95, label: '¡ARCOÍRIS LEGENDARIO!' }
    ]
  }
}
