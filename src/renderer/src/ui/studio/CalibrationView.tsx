import { useState } from 'react'
import { activeProfile, type AudioProfile } from '../../core/audio/AudioConfig'
import { audioEngine } from '../../core/audio/AudioEngine'
import { dominantFrequency } from '../../core/studio/analysis'
import {
  calibrationWarnings,
  checkCalibratorSignal,
  gainAdvice,
  loopbackResult,
  pushCalibration,
  TOLERANCE_DB,
  verifyAgainstReference,
  type CalibrationRecord,
  type GainAdvice,
  type LoopbackPoint,
  type LoopbackResult,
  type ToleranceClass,
  type Verification
} from '../../core/studio/calibration'
import { calibrationOffset, SoundLevelMeter } from '../../core/studio/loudness'
import { useEngineState } from '../hooks'
import { useStore } from '../store'
import { generator } from './generator'
import { Readout, Segmented } from './widgets'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Capture {
  /** Mean-square level of each 100 ms block, dBFS (sine at full scale = −3) */
  blocks: number[]
  peakDb: number
  /** A-weighted Leq over the capture, dBFS */
  laeq: number
}

/** Listens to the input for `ms` (after a short settle) and summarizes it */
async function captureInput(ms: number, settleMs = 300): Promise<Capture> {
  const sr = audioEngine.sampleRate
  const block = Math.round(sr * 0.1)
  const blocks: number[] = []
  let acc = 0
  let n = 0
  let peak = 0
  let armed = false
  const meter = new SoundLevelMeter(sr, 0)
  const off = audioEngine.onPcm((chunk) => {
    if (!armed) return
    meter.push(chunk)
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i]
      acc += v * v
      if (Math.abs(v) > peak) peak = Math.abs(v)
      if (++n === block) {
        blocks.push(acc > 0 ? Math.max(-100, 10 * Math.log10(acc / n)) : -100)
        acc = 0
        n = 0
      }
    }
  })
  await wait(settleMs)
  armed = true
  await wait(ms)
  off()
  return { blocks, peakDb: peak > 0 ? Math.max(-100, 20 * Math.log10(peak)) : -100, laeq: meter.reading().leq.A }
}

function useProfile(): [AudioProfile, (patch: Partial<AudioProfile>) => void] {
  const { data, update } = useStore()
  const p = activeProfile(data.audio)
  return [p, (patch) => update('audio', (a) => ({ ...a, profiles: a.profiles.map((x) => (x.id === a.activeProfileId ? { ...x, ...patch } : x)) }))]
}

function useHistory(profileId: string): [CalibrationRecord[], (rec: CalibrationRecord) => void] {
  const { data, update } = useStore()
  const list = data.studio.calibrations[profileId] ?? []
  return [list, (rec) => update('studio', (s) => ({ ...s, calibrations: { ...s.calibrations, [profileId]: pushCalibration(s.calibrations[profileId] ?? [], rec) } }))]
}

const newId = (): string => `cal-${Date.now().toString(36)}`
const fmtDate = (iso: string): string => new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })
const METHOD: Record<CalibrationRecord['method'], string> = { calibrator: 'Calibrador', manual: 'Sonómetro de referencia', loopback: 'Loopback' }

export function CalibrationView(): JSX.Element {
  const { data, update } = useStore()
  const engine = useEngineState()
  const [profile, setProfile] = useProfile()
  const [history, addRecord] = useHistory(profile.id)
  const cls = data.studio.toleranceClass
  // Loopback records don't set an SPL offset, so they don't count as the acoustic calibration
  const current = history.find((h) => h.method !== 'loopback')
  const warnings = calibrationWarnings(current, { deviceLabel: engine.status === 'running' ? engine.label : undefined, gainDb: profile.gainDb, offsetDb: profile.splOffset })
  const ready = engine.status === 'running'

  return (
    <div className="st-calib">
      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Estado de calibración · {profile.name}</h2>
          <Segmented<ToleranceClass>
            value={cls}
            onChange={(v) => update('studio', (s) => ({ ...s, toleranceClass: v }))}
            options={[
              [1, `Clase 1 (±${TOLERANCE_DB[1]} dB)`],
              [2, `Clase 2 (±${TOLERANCE_DB[2]} dB)`]
            ]}
            title="Tolerancia IEC 61672 con la que se juzgan las verificaciones"
          />
        </header>
        <div className="st-readouts">
          <Readout label="Offset SPL" value={profile.splOffset.toFixed(1)} unit="dB" big />
          <Readout label="Último método" value={current ? METHOD[current.method] : 'Sin calibrar'} unit="" tone={current ? 'ok' : 'warn'} />
          <Readout label="Fecha" value={current ? fmtDate(current.atIso) : '—'} unit="" />
          <Readout label="Entrada actual" value={ready ? (engine.label ?? '—') : 'Sin señal'} unit="" />
        </div>
        {warnings.length > 0 ? (
          <ul className="st-warnings">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        ) : (
          <p className="st-small ok">✓ Calibración vigente para esta entrada.</p>
        )}
      </section>

      <div className="st-calib-grid">
        <CalibratorPanel profile={profile} cls={cls} ready={ready} onCalibrated={(offset, rec) => {
          setProfile({ splOffset: offset })
          addRecord(rec)
        }} label={engine.label} />
        <ReferenceMeterPanel profile={profile} ready={ready} onCalibrated={(offset, rec) => {
          setProfile({ splOffset: offset })
          addRecord(rec)
        }} label={engine.label} />
        <LoopbackPanel profile={profile} ready={ready} advanced={data.audio.mode === 'advanced'} onApplyGain={(gainDb) => setProfile({ gainDb })} onRecord={addRecord} label={engine.label} />
        <GainAssistant profile={profile} ready={ready} onNoiseFloor={(noiseFloorDb) => setProfile({ noiseFloorDb })} />
      </div>

      <section className="st-panel">
        <header className="st-panel-head">
          <h2>Historial de calibraciones</h2>
          <span className="st-muted st-small">Últimas {history.length} de este perfil</span>
        </header>
        {history.length === 0 ? (
          <p className="st-muted st-small">Todavía no hay calibraciones. Cada perfil de audio (micro + interfaz) guarda las suyas.</p>
        ) : (
          <table className="st-table">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Método</th>
                <th>Offset</th>
                <th>Medido</th>
                <th>Estabilidad</th>
                <th>Entrada</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{fmtDate(h.atIso)}</td>
                  <td>
                    {METHOD[h.method]}
                    {h.refDb !== undefined ? ` · ${h.refDb} dB` : ''}
                  </td>
                  <td>{h.method === 'loopback' ? '—' : `${h.offsetDb.toFixed(1)} dB`}</td>
                  <td>{h.measuredDbfs !== undefined ? `${h.measuredDbfs.toFixed(1)} dBFS` : '—'}</td>
                  <td>{h.spreadDb !== undefined ? `±${(h.spreadDb / 2).toFixed(2)} dB` : '—'}</td>
                  <td className="st-small">{h.deviceLabel ?? '—'}</td>
                  <td>
                    {h.method !== 'loopback' && Math.abs(h.offsetDb - profile.splOffset) > 0.05 && (
                      <button className="st-btn ghost" onClick={() => setProfile({ splOffset: h.offsetDb })} title="Volver a usar este offset">
                        Restaurar
                      </button>
                    )}
                    {h.note && <span className="st-small st-muted">{h.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

// ---- Acoustic calibrator: calibrate and verify

function CalibratorPanel({
  profile,
  cls,
  ready,
  label,
  onCalibrated
}: {
  profile: AudioProfile
  cls: ToleranceClass
  ready: boolean
  label?: string
  onCalibrated: (offset: number, rec: CalibrationRecord) => void
}): JSX.Element {
  const [ref, setRef] = useState(94)
  const [busy, setBusy] = useState<'' | 'cal' | 'verify'>('')
  const [msg, setMsg] = useState<{ text: string; problems?: string[] } | null>(null)
  const [check, setCheck] = useState<Verification | null>(null)

  const run = async (mode: 'cal' | 'verify'): Promise<void> => {
    setBusy(mode)
    setMsg(null)
    setCheck(null)
    const cap = await captureInput(3000, 500)
    const s = audioEngine.spectrumDb()
    const dom = s ? dominantFrequency(s.data, s.sampleRate, s.fftSize) : null
    setBusy('')
    const sig = checkCalibratorSignal(cap.blocks, dom?.hz ?? null, cap.peakDb)
    if (!sig.ok) {
      setMsg({ text: 'Medida rechazada:', problems: sig.problems })
      return
    }
    if (mode === 'verify') {
      setCheck(verifyAgainstReference(sig.levelDbfs + profile.splOffset, ref, cls))
      return
    }
    const offset = calibrationOffset(sig.levelDbfs, ref)
    onCalibrated(offset, {
      id: newId(),
      atIso: new Date().toISOString(),
      method: 'calibrator',
      offsetDb: offset,
      refDb: ref,
      measuredDbfs: sig.levelDbfs,
      spreadDb: sig.spreadDb,
      freqHz: dom?.hz,
      deviceLabel: label,
      gainDb: profile.gainDb
    })
    setMsg({ text: `Calibrado: ${sig.levelDbfs} dBFS = ${ref} dB SPL → offset ${offset} dB (estable ±${(sig.spreadDb / 2).toFixed(2)} dB${dom ? `, ${dom.hz} Hz` : ''}).` })
  }

  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Calibrador acústico</h2>
        <Segmented<number>
          value={ref}
          onChange={setRef}
          options={[
            [94, '94 dB'],
            [114, '114 dB']
          ]}
        />
      </header>
      <div className="st-row">
        <button className="st-btn primary" disabled={!!busy || !ready} onClick={() => void run('cal')}>
          {busy === 'cal' ? 'Midiendo… no muevas el micro' : 'Calibrar (3 s)'}
        </button>
        <button className="st-btn" disabled={!!busy || !ready} onClick={() => void run('verify')} title="Vuelve a medir el calibrador y compara con su nivel nominal, sin cambiar nada">
          {busy === 'verify' ? 'Verificando…' : 'Verificar'}
        </button>
      </div>
      {msg && (
        <div className="st-small">
          {msg.text}
          {msg.problems && (
            <ul className="st-warnings">
              {msg.problems.map((p) => (
                <li key={p}>⚠ {p}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {check && (
        <div className={`st-verdict ${check.pass ? 'ok' : 'bad'}`}>
          <b>{check.pass ? '✓ PASA' : '✗ NO PASA'}</b>
          <span>{check.message}</span>
        </div>
      )}
      <p className="st-muted st-small">
        Encaja el calibrador (1 kHz) en la cápsula con la ganancia que vayas a usar. Se rechaza la medida si el nivel varía más de 0,6 dB, si no está en 1 kHz o si satura. Verificar no cambia
        nada: dice si la calibración actual sigue dentro de la tolerancia elegida.
      </p>
    </section>
  )
}

// ---- Match a reference sound level meter

function ReferenceMeterPanel({
  profile,
  ready,
  label,
  onCalibrated
}: {
  profile: AudioProfile
  ready: boolean
  label?: string
  onCalibrated: (offset: number, rec: CalibrationRecord) => void
}): JSX.Element {
  const [refDb, setRefDb] = useState(80)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const run = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    const cap = await captureInput(5000)
    setBusy(false)
    if (cap.laeq < -80) {
      setMsg('Señal demasiado baja. Usa ruido rosa del Generador a volumen moderado.')
      return
    }
    const offset = calibrationOffset(cap.laeq, refDb)
    onCalibrated(offset, { id: newId(), atIso: new Date().toISOString(), method: 'manual', offsetDb: offset, refDb, measuredDbfs: Math.round(cap.laeq * 10) / 10, deviceLabel: label, gainDb: profile.gainDb, note: 'LAeq 5 s' })
    setMsg(`Igualado: LAeq ${cap.laeq.toFixed(1)} dBFS = ${refDb} dB(A) → offset ${offset} dB.`)
  }

  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Igualar con un sonómetro</h2>
      </header>
      <div className="st-row">
        <label className="st-inline">
          El sonómetro de referencia marca
          <input type="number" step={0.1} value={refDb} onChange={(e) => setRefDb(Number(e.target.value) || 0)} />
          dB(A)
        </label>
        <button className="st-btn primary" disabled={busy || !ready} onClick={() => void run()}>
          {busy ? 'Midiendo 5 s…' : 'Igualar'}
        </button>
      </div>
      {msg && <p className="st-small">{msg}</p>}
      <p className="st-muted st-small">
        Sin calibrador: pon un sonómetro (o una app fiable) junto al micro, reproduce ruido rosa constante, escribe lo que marca en LAeq/dB(A) y pulsa Igualar. Es menos preciso que un
        calibrador (±2 dB típico).
      </p>
    </section>
  )
}

// ---- Electrical loopback

const LOOP_FREQS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const LOOP_LEVEL = -20

function LoopbackPanel({
  profile,
  ready,
  advanced,
  label,
  onApplyGain,
  onRecord
}: {
  profile: AudioProfile
  ready: boolean
  advanced: boolean
  label?: string
  onApplyGain: (gainDb: number) => void
  onRecord: (rec: CalibrationRecord) => void
}): JSX.Element {
  const [busy, setBusy] = useState<number | null>(null)
  const [result, setResult] = useState<LoopbackResult | null>(null)
  const [error, setError] = useState('')

  const run = async (): Promise<void> => {
    if (!confirm('Conecta con un cable la SALIDA de la interfaz a su ENTRADA (o baja los altavoces): se enviarán tonos a −20 dBFS. ¿Continuar?')) return
    setResult(null)
    setError('')
    const points: LoopbackPoint[] = []
    try {
      for (const hz of LOOP_FREQS) {
        setBusy(hz)
        if (generator.running) generator.update({ kind: 'sine', freqHz: hz, levelDb: LOOP_LEVEL, sweepSeconds: 10 })
        else generator.start({ kind: 'sine', freqHz: hz, levelDb: LOOP_LEVEL, sweepSeconds: 10 })
        const cap = await captureInput(350, 350)
        const ms = cap.blocks.length ? cap.blocks.reduce((a, v) => a + Math.pow(10, v / 10), 0) / cap.blocks.length : 0
        // Mean-square of a sine is 3 dB under its peak: compare peak to peak
        points.push({ hz, sentDbfs: LOOP_LEVEL, receivedDbfs: ms > 0 ? 10 * Math.log10(ms) + 3.01 : -200 })
      }
    } finally {
      generator.stop()
      setBusy(null)
    }
    const r = loopbackResult(points)
    if (!r) {
      setError('No llegó nada a la entrada: revisa el cable y que la salida elegida (🔊) sea la de la interfaz.')
      return
    }
    setResult(r)
    onRecord({ id: newId(), atIso: new Date().toISOString(), method: 'loopback', offsetDb: profile.splOffset, measuredDbfs: LOOP_LEVEL + r.gainDb, deviceLabel: label, gainDb: profile.gainDb, note: `ganancia ${r.gainDb} dB · planitud ${r.flatnessDb} dB` })
  }

  const correction = result ? Math.round((profile.gainDb - result.gainDb) * 10) / 10 : 0
  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Cadena eléctrica (loopback)</h2>
        <button className="st-btn primary" disabled={busy !== null || !ready} onClick={() => void run()}>
          {busy !== null ? `Tono ${busy >= 1000 ? `${busy / 1000} kHz` : `${busy} Hz`}…` : 'Medir con tonos'}
        </button>
      </header>
      {result && (
        <>
          <div className="st-readouts">
            <Readout label="Ganancia de la cadena" value={`${result.gainDb > 0 ? '+' : ''}${result.gainDb}`} unit="dB" big tone={Math.abs(result.gainDb) < 0.5 ? 'ok' : 'warn'} />
            <Readout label="Planitud 63 Hz–16 kHz" value={String(result.flatnessDb)} unit="dB" tone={result.flatnessDb <= 1 ? 'ok' : result.flatnessDb <= 3 ? 'warn' : 'bad'} />
          </div>
          <div className="st-loop">
            {result.response.map((p) => (
              <div key={p.hz} title={`${p.hz} Hz: ${p.db > 0 ? '+' : ''}${p.db} dB`}>
                <i
                  style={p.db >= 0 ? { height: `${Math.min(50, p.db * 10)}%`, bottom: '50%' } : { height: `${Math.min(50, -p.db * 10)}%`, top: '50%' }}
                  className={Math.abs(p.db) <= 0.5 ? 'ok' : 'warn'}
                />
                <span>{p.hz >= 1000 ? `${p.hz / 1000}k` : p.hz}</span>
              </div>
            ))}
          </div>
          <p className="st-small">{result.message}</p>
          {Math.abs(result.gainDb) >= 0.5 && (
            <div className="st-row">
              <button className="st-btn" disabled={!advanced} onClick={() => onApplyGain(correction)} title={advanced ? '' : 'La ganancia digital solo se aplica en modo avanzado de audio'}>
                Compensar: ganancia del perfil {profile.gainDb} → {correction} dB
              </button>
              {!advanced && <span className="st-small st-muted">Disponible en modo de audio avanzado (pestaña Entrada).</span>}
            </div>
          )}
        </>
      )}
      {error && <p className="st-error">{error}</p>}
      <p className="st-muted st-small">
        Envía 9 tonos de 63 Hz a 16 kHz por la salida y mide lo que vuelve por la entrada. Dice si la interfaz pierde o suma nivel y si su respuesta es plana (debería serlo: ±0,5 dB). La
        cadena con micrófono se calibra con el calibrador acústico.
      </p>
    </section>
  )
}

// ---- Gain assistant from noise floor and loudest peak

function GainAssistant({ profile, ready, onNoiseFloor }: { profile: AudioProfile; ready: boolean; onNoiseFloor: (db: number) => void }): JSX.Element {
  const [step, setStep] = useState<'idle' | 'silence' | 'loud'>('idle')
  const [noise, setNoise] = useState<number | null>(null)
  const [advice, setAdvice] = useState<GainAdvice | null>(null)
  const [peak, setPeak] = useState<number | null>(null)

  const run = async (): Promise<void> => {
    setAdvice(null)
    setStep('silence')
    const quiet = await captureInput(3000)
    // A quiet percentile ignores a cough or a door during the silence
    const sorted = [...quiet.blocks].sort((a, b) => a - b)
    const floor = Math.round((sorted[Math.floor(sorted.length * 0.2)] ?? -100) * 10) / 10
    setNoise(floor)
    setStep('loud')
    const loud = await captureInput(5000, 100)
    setPeak(Math.round(loud.peakDb * 10) / 10)
    setStep('idle')
    setAdvice(gainAdvice(floor, loud.peakDb))
  }

  return (
    <section className="st-panel">
      <header className="st-panel-head">
        <h2>Asistente de ganancia</h2>
        <button className="st-btn primary" disabled={step !== 'idle' || !ready} onClick={() => void run()}>
          {step === 'silence' ? '🤫 Silencio… 3 s' : step === 'loud' ? '📣 ¡Habla o grita fuerte! 5 s' : 'Empezar'}
        </button>
      </header>
      {advice && noise !== null && peak !== null && (
        <>
          <div className="st-readouts">
            <Readout label="Ruido de fondo" value={noise.toFixed(1)} unit="dBFS" />
            <Readout label="Pico más fuerte" value={peak.toFixed(1)} unit="dBFS" tone={peak > -1 ? 'bad' : peak > -6 ? 'warn' : 'ok'} />
            <Readout label="Rango útil" value={advice.rangeDb.toFixed(0)} unit="dB" tone={advice.rangeDb >= 40 ? 'ok' : advice.rangeDb >= 30 ? 'warn' : 'bad'} />
            <Readout label="Cambio sugerido" value={advice.changeDb === 0 ? '0' : `${advice.changeDb > 0 ? '+' : ''}${advice.changeDb}`} unit="dB" big tone={advice.status === 'ok' ? 'ok' : 'warn'} />
          </div>
          <p className={`st-advice-line ${advice.status}`}>{advice.message}</p>
          <div className="st-row">
            <button className="st-btn" onClick={() => onNoiseFloor(noise)} disabled={Math.abs(noise - profile.noiseFloorDb) < 0.1}>
              Guardar ruido de fondo en «{profile.name}» ({profile.noiseFloorDb} → {noise} dBFS)
            </button>
          </div>
        </>
      )}
      <p className="st-muted st-small">
        Primero 3 s de silencio (ruido de la sala), luego 5 s de tu voz más fuerte. Recomienda cuánto mover el preamplificador para que los picos queden en −12 dBFS. Si cambias la
        ganancia del preamplificador, vuelve a calibrar.
      </p>
    </section>
  )
}
