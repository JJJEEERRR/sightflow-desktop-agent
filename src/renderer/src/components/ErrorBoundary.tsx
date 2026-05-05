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
    // Phase 5 PR4: ErrorBoundary uses raw Tailwind utilities (not the
    // shadcn `<Button>` / `<Card>` primitives) because it must keep
    // working even if the React subtree producing those primitives is
    // exactly what crashed. A plain <div> + <button> can't fail to render.
    return (
      <div
        role="alert"
        className="m-4 flex h-[calc(100vh-32px)] flex-col gap-3 overflow-auto rounded-md border border-border bg-card/80 p-6 text-foreground backdrop-blur-md"
      >
        <h2 className="text-base font-semibold text-destructive">
          {i18n.t('diag.errorBoundary.title')}
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {i18n.t('diag.errorBoundary.hint')}
        </p>
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-black/25 p-3 font-mono text-[11px] text-foreground">
          {error.name}: {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {errorInfo ? `\n\nComponent stack:${errorInfo}` : ''}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-secondary px-4 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
            onClick={(): void => {
              void this.handleCopy()
            }}
          >
            {i18n.t('diag.errorBoundary.copy')}
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={this.handleReload}
          >
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
