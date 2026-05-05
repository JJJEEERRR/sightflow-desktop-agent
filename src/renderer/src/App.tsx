import { JSX, StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AppRoutes } from './routes'
import { createQueryClient } from './lib/query-client'
import './index.css'

/**
 * Root renderer component. The app shell is intentionally tiny — a single
 * QueryClient instance, an error boundary, and the route tree. Every
 * page-specific concern lives under `pages/` (with shared chrome in
 * `layout/AppLayout.tsx`); every IPC concern lives under `lib/ipc.ts`;
 * every cross-page state lives in `stores/`.
 *
 * The QueryClient is created at module evaluation time (not per-render) so
 * cache state survives navigation between routes — that's the whole point
 * of the cache layer.
 */
const queryClient = createQueryClient()

export default function App(): JSX.Element {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </QueryClientProvider>
    </StrictMode>
  )
}
