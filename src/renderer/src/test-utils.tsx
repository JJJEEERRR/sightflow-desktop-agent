/**
 * Renderer test utilities.
 *
 * `renderWithProviders` is the canonical way to mount a React subtree under
 * the same providers the app uses in production: a fresh `QueryClient` plus
 * a `MemoryRouter` (vs HashRouter in production — HashRouter relies on
 * `window.location.hash` which jsdom can't drive cleanly across tests).
 *
 * Each call constructs its OWN QueryClient with `retry: false`,
 * `gcTime: 0`, `staleTime: 0` so cache state from a previous test cannot
 * leak into the next one (a common react-query test smell that masks IPC
 * regressions).
 *
 * `installFakeElectron` mirrors the listener-tracking fake used directly in
 * the existing component test files (`DiagnosticsPanel.test.tsx`,
 * `AntiDetectionSettings.test.tsx`). Centralized here so future test files
 * don't have to copy-paste the same 30 lines of Map<string, Set<Listener>>
 * plumbing.
 */
import type { JSX, ReactElement, ReactNode } from 'react'
import { vi } from 'vitest'
import { render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

type ListenerCleanup = () => void
type Listener = (...args: unknown[]) => void

export interface FakeElectron {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  /** Imperatively fire all listeners registered for `channel`. */
  emit: (channel: string, payload: unknown) => void
}

/**
 * Installs `window.electron` with a programmable invoke handler and a
 * listener-tracking `on` so tests can simulate main-process push events.
 *
 * Returns the mock so the caller can assert `invoke.mock.calls`, or trigger
 * push events via `mock.emit('engine:state', payload)`.
 */
export function installFakeElectron(
  invokeImpl: (channel: string, ...args: unknown[]) => unknown
): FakeElectron {
  const listeners = new Map<string, Set<Listener>>()
  const mock: FakeElectron = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) =>
      invokeImpl(channel, ...args)
    ) as unknown as ReturnType<typeof vi.fn>,
    on: vi.fn((channel: string, listener: Listener): ListenerCleanup => {
      let bucket = listeners.get(channel)
      if (!bucket) {
        bucket = new Set()
        listeners.set(channel, bucket)
      }
      bucket.add(listener)
      return (): void => {
        bucket?.delete(listener)
      }
    }) as unknown as ReturnType<typeof vi.fn>,
    send: vi.fn(),
    emit: (channel, payload): void => {
      listeners.get(channel)?.forEach((l) => l(payload))
    }
  }
  Object.defineProperty(window, 'electron', { value: mock, writable: true, configurable: true })
  Object.defineProperty(window, 'osInfo', {
    value: { platform: 'win32' },
    writable: true,
    configurable: true
  })
  return mock
}

interface RenderOptions {
  /** Initial entry passed to `MemoryRouter`. Defaults to `'/'`. */
  route?: string
}

/**
 * Render `ui` inside a fresh QueryClientProvider + MemoryRouter. Use this
 * for any test mounting a component that internally uses `useQuery`,
 * `useMutation`, or `useNavigate`.
 *
 * Tests mounting `<App />` directly should keep using bare `render(...)` —
 * App.tsx provides its own QueryClientProvider + HashRouter, and double
 * wrapping nested routers breaks navigation.
 */
export function renderWithProviders(ui: ReactElement, options: RenderOptions = {}): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false }
    }
  })
  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options.route ?? '/']}>{children}</MemoryRouter>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper })
}
