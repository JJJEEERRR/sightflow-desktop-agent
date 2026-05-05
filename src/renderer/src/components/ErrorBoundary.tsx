import { Component, JSX, ReactNode } from 'react'
import i18n from '../i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  errorInfo: string | null
}

/**
 * Top-level renderer error boundary. Without this, a thrown render error
 * tears down the entire React tree leaving the user with a blank window
 * and no recourse — for an always-on agent UI that is unacceptable. The
 * boundary surfaces the error stack and offers Copy / Reload actions.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    this.setState({ error, errorInfo: info.componentStack ?? null })
    // Best-effort surface to console; the renderer can't talk to the structured
    // logger directly, so we rely on Electron's devtools / the user copying the
    // stack from the boundary UI if they want it captured.
    console.error('[Renderer ErrorBoundary]', error, info.componentStack)
  }

  private handleCopy = async (): Promise<void> => {
    const { error, errorInfo } = this.state
    if (!error) return
    const text = `${error.name}: ${error.message}\n\nStack:\n${error.stack ?? '(no stack)'}\n\nComponent stack:\n${errorInfo ?? '(no component stack)'}`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // clipboard API can fail in older Electron without a focused window;
      // fall back to a transient textarea.
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } finally {
        document.body.removeChild(ta)
      }
    }
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children

    // Class components can't use the `useTranslation` hook, so the error
    // boundary reaches into the imperative i18next instance directly. The
    // boundary's render path is a hard error case (renderer crash) — it
    // doesn't need to react to live language changes.
    return (
      <div className="error-boundary" role="alert">
        <h2 className="error-boundary-title">{i18n.t('diag.errorBoundary.title')}</h2>
        <p className="error-boundary-hint">{i18n.t('diag.errorBoundary.hint')}</p>
        <pre className="error-boundary-pre">
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {errorInfo ? `\n\nComponent stack:${errorInfo}` : ''}
        </pre>
        <div className="error-boundary-actions">
          <button
            className="btn btn-secondary"
            onClick={(): void => {
              void this.handleCopy()
            }}
          >
            {i18n.t('diag.errorBoundary.copy')}
          </button>
          <button className="btn btn-primary" onClick={this.handleReload}>
            {i18n.t('diag.errorBoundary.reload')}
          </button>
        </div>
      </div>
    )
  }
}

// Re-export as default for compatibility with potential lazy() usage later.
export default ErrorBoundary

// JSX namespace touch so eslint doesn't flag the JSX import as unused under
// noUnusedLocals; the type is real but only consumed transitively.
export type _ErrorBoundaryJSX = JSX.Element
