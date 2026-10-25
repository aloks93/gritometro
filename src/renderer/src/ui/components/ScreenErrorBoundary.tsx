import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  onHome: () => void
}

/**
 * A render error in one screen must never blank the whole app mid-party:
 * show a friendly fallback with a way back home instead.
 */
export class ScreenErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('Screen crashed:', error)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="screen crash-screen">
        <h1 className="screen-title">😵 ¡Uy! Algo falló en esta pantalla</h1>
        <p className="muted">Los jugadores y récords están a salvo.</p>
        <button
          className="btn primary huge"
          onClick={() => {
            this.setState({ error: null })
            this.props.onHome()
          }}
        >
          🏠 Volver al inicio
        </button>
        <small className="muted">{this.state.error.message}</small>
      </div>
    )
  }
}
