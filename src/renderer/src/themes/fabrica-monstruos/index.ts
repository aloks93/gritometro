import type { Theme } from '../Theme'
import { ScreamTank } from './ScreamTank'
import { FactoryBackground } from './FactoryBackground'
import { DoorReveal } from './DoorReveal'
import './fabrica.css'

// Original "scream factory" theme: canisters that fill with scream energy,
// doors on a conveyor rail and an alarm siren for records.
export const fabricaMonstruosTheme: Theme = {
  id: 'fabrica-monstruos',
  name: 'Fábrica de Monstruos',
  description: 'Tanques de gritos, puertas voladoras y sirena de alarma. ¡A asustar!',
  tokens: {
    bg: '#0b2545',
    bgAlt: '#13406b',
    surface: 'rgba(8, 24, 48, 0.72)',
    surfaceBorder: 'rgba(63, 208, 201, 0.35)',
    text: '#f4fbff',
    textMuted: '#9fc3dd',
    primary: '#ffd23f',
    primaryText: '#1c1a10',
    accent: '#3fd0c9',
    success: '#a3e635',
    danger: '#ff5964',
    meterLow: '#3fd0c9',
    meterMid: '#a3e635',
    meterHigh: '#ffd23f',
    fontDisplay: "'Luckiest Guy', 'Impact', sans-serif",
    fontBody: "'Nunito', 'Segoe UI', sans-serif",
    radius: '18px'
  },
  texts: {
    appTitle: 'Gritómetro',
    subtitle: 'Fábrica de Gritos · Departamento de Sustos',
    screamCta: '¡A GRITAR!',
    silenceCta: 'Shhh... ¡que no despierte el niño!',
    getReady: 'Prepárate, asustador...',
    resultTitle: 'Energía de grito recolectada',
    newRecord: '¡NUEVO RÉCORD DE LA FÁBRICA!',
    winnerTitle: 'Asustador Estrella',
    certificateTitle: 'Certificado de Asustador Profesional',
    certificateBody: 'por llenar el tanque de gritos más grande de toda la fábrica',
    levels: [
      { min: 0, label: 'Ronroneo de gatito' },
      { min: 15, label: 'Susurro de monstruo' },
      { min: 30, label: 'Rugido aprendiz' },
      { min: 50, label: 'Susto de clóset' },
      { min: 70, label: 'Grito de alarma' },
      { min: 85, label: '¡ALERTA ROJA!' },
      { min: 95, label: '¡ASUSTADOR LEGENDARIO!' }
    ]
  },
  components: {
    Meter: ScreamTank,
    Background: FactoryBackground,
    Reveal: DoorReveal
  },
  soundStyle: 'factory',
  images: {},
  sounds: {}
}
