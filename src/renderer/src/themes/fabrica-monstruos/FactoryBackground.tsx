const DOORS = [
  { color: '#ff6fb5', pattern: 'flowers' },
  { color: '#3fd0c9', pattern: 'plain' },
  { color: '#ffd23f', pattern: 'stripes' },
  { color: '#8b5cf6', pattern: 'dots' },
  { color: '#a3e635', pattern: 'plain' },
  { color: '#fb923c', pattern: 'stripes' },
  { color: '#60a5fa', pattern: 'dots' },
  { color: '#f43f5e', pattern: 'flowers' },
  { color: '#2dd4bf', pattern: 'stripes' },
  { color: '#facc15', pattern: 'dots' }
]

/** Factory floor: doors gliding along an overhead rail, hazard stripes at the bottom */
export function FactoryBackground(): JSX.Element {
  const doors = [...DOORS, ...DOORS]
  return (
    <div className="factory-bg" aria-hidden>
      <div className="factory-glow" />
      <div className="factory-rail" />
      <div className="factory-doors">
        {doors.map((d, i) => (
          <div key={i} className="factory-door-hanger">
            <div className={`factory-door pattern-${d.pattern}`} style={{ ['--door' as string]: d.color }}>
              <span className="door-window" />
              <span className="door-knob" />
            </div>
          </div>
        ))}
      </div>
      <div className="factory-pipes" />
      <div className="factory-hazard" />
    </div>
  )
}
