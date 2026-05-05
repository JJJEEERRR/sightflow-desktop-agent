import { JSX } from 'react'
import { DiagnosticsPanel } from '../components/DiagnosticsPanel'
import { useToastStore } from '../stores/toast'

/**
 * `/diagnostics` route. Thin wrapper that bridges the legacy
 * `onToast` callback API of `DiagnosticsPanel` to the global toast store.
 * Once `DiagnosticsPanel` is refactored to call `useToastStore` directly
 * (PR2), this wrapper collapses to a single-line render.
 */
export function DiagnosticsPage(): JSX.Element {
  const push = useToastStore((s) => s.push)
  return <DiagnosticsPanel onToast={push} />
}
