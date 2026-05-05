/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { DiagnosticsPanel } from './DiagnosticsPanel'
import { setLocale } from '../i18n'
import type { LifecycleStatePayload, LogRecord } from '../types'

vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('../index.css', () => ({}))

// All assertions in this file rely on the English copy so they remain
// stable regardless of the global default locale (which is 'zh' in
// production). Set once for the suite; setLocale is a process-wide singleton
// but no other test file currently asserts on i18n strings from the panel.
beforeAll(() => {
  setLocale('en')
})

afterAll(() => {
  setLocale('zh')
})

type ListenerCleanup = () => void
type Listener = (...args: unknown[]) => void

interface MockElectron {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  /** Imperative trigger used by tests to fire push-channel events. */
  emit: (channel: string, payload: unknown) => void
}

/**
 * Installs a window.electron mock that supports both invoke (request/response)
 * and on (push channel) flows. The returned `emit` fires every listener
 * registered for a given channel — that's how the tests can simulate the main
 * process pushing engine:log-record / engine:state events.
 */
function installElectronMock(
  invokeImpl: (channel: string, ...args: unknown[]) => unknown
): MockElectron {
  const listeners = new Map<string, Set<Listener>>()
  const mock: MockElectron = {
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
  return mock
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SAMPLE_LIFECYCLE: LifecycleStatePayload = {
  event: { from: 'idle', to: 'running', at: '2026-05-05T03:00:00.000Z' },
  snapshot: {
    state: 'running',
    enteredAt: '2026-05-05T03:00:00.000Z',
    restartBudget: { used: 0, max: 5, windowEndsAt: '2026-05-05T04:00:00.000Z' }
  }
}

const SAMPLE_LOG_RECORD: LogRecord = {
  ts: '2026-05-05T03:00:01.234Z',
  level: 'info',
  phase: 'engine',
  msg: 'Tick complete'
}

describe('DiagnosticsPanel — initial render', () => {
  it('shows an idle pill and empty placeholders when there is no data yet', async () => {
    installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return null
      if (channel === 'logs:recent') return []
      return null
    })
    render(<DiagnosticsPanel />)

    // The lifecycle card falls back to an "idle" pill when snapshot is null.
    expect(screen.getAllByText('idle').length).toBeGreaterThan(0)
    expect(screen.getByText('No log records yet')).toBeInTheDocument()
    expect(screen.getByText('No transitions yet')).toBeInTheDocument()
  })

  it('backfills lifecycle snapshot and recent logs from IPC on mount', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return SAMPLE_LIFECYCLE.snapshot
      if (channel === 'logs:recent') return [SAMPLE_LOG_RECORD]
      return null
    })

    render(<DiagnosticsPanel />)

    await waitFor(() => {
      expect(screen.getByText('Tick complete')).toBeInTheDocument()
    })
    // Lifecycle card now shows running, with a 0/5 restart budget.
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('0/5')).toBeInTheDocument()
    expect(electron.invoke).toHaveBeenCalledWith('engine:lifecycle')
    expect(electron.invoke).toHaveBeenCalledWith('logs:recent', 200)
  })
})

describe('DiagnosticsPanel — live IPC streams', () => {
  it('appends incoming engine:log-record events to the log stream', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return null
      if (channel === 'logs:recent') return []
      return null
    })

    render(<DiagnosticsPanel />)

    // Wait for the backfill effect to settle so the empty placeholder is up.
    await waitFor(() => {
      expect(screen.getByText('No log records yet')).toBeInTheDocument()
    })

    electron.emit('engine:log-record', {
      ts: '2026-05-05T03:01:00.000Z',
      level: 'warn',
      phase: 'rpa-device',
      msg: 'No unread contacts found'
    } satisfies LogRecord)

    await waitFor(() => {
      expect(screen.getByText('No unread contacts found')).toBeInTheDocument()
    })
    // The level badge should be rendered in upper-case.
    expect(screen.getByText('WARN')).toBeInTheDocument()
  })

  it('updates the lifecycle card and pushes a transition row when engine:state arrives', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return null
      if (channel === 'logs:recent') return []
      return null
    })

    render(<DiagnosticsPanel />)

    await waitFor(() => {
      expect(screen.getByText('No transitions yet')).toBeInTheDocument()
    })

    electron.emit('engine:state', SAMPLE_LIFECYCLE)

    // Both the lifecycle card AND the new transition row render a "running"
    // pill, so getAllByText is the right matcher here.
    await waitFor(() => {
      const matches = screen.getAllByText('running')
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })

    // The transition row renders both ends of the arrow as state pills.
    expect(document.querySelectorAll('.diag-transition .diag-state-pill').length).toBe(2)
  })
})

describe('DiagnosticsPanel — filters', () => {
  it('filters logs by level when the level dropdown changes', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return null
      if (channel === 'logs:recent')
        return [
          { ts: '2026-05-05T03:00:01Z', level: 'info', phase: 'engine', msg: 'info-msg' },
          { ts: '2026-05-05T03:00:02Z', level: 'error', phase: 'engine', msg: 'error-msg' }
        ] satisfies LogRecord[]
      return null
    })
    const user = userEvent.setup()
    render(<DiagnosticsPanel />)

    await waitFor(() => {
      expect(screen.getByText('info-msg')).toBeInTheDocument()
      expect(screen.getByText('error-msg')).toBeInTheDocument()
    })

    const levelSelect = screen.getByLabelText('Level') as HTMLSelectElement
    await user.selectOptions(levelSelect, 'error')

    await waitFor(() => {
      expect(screen.queryByText('info-msg')).not.toBeInTheDocument()
      expect(screen.getByText('error-msg')).toBeInTheDocument()
    })
    // Sanity: backfill happened exactly once even after filtering.
    expect(
      (electron.invoke.mock.calls as unknown[][]).filter((c) => c[0] === 'logs:recent').length
    ).toBe(1)
  })
})

describe('DiagnosticsPanel — export', () => {
  it('serializes the current state to a Blob and triggers a download', async () => {
    installElectronMock((channel) => {
      if (channel === 'engine:lifecycle') return SAMPLE_LIFECYCLE.snapshot
      if (channel === 'logs:recent') return [SAMPLE_LOG_RECORD]
      return null
    })

    // jsdom does not implement createObjectURL/revokeObjectURL — install plain
    // mocks (not vi.spyOn) so we can assert the bundle wiring without needing
    // the real APIs.
    const createObjectURLSpy = vi.fn((_blob: Blob): string => 'blob:fake-url')
    const revokeObjectURLSpy = vi.fn((_url: string): void => {})
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURLSpy,
      writable: true,
      configurable: true
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURLSpy,
      writable: true,
      configurable: true
    })
    // Block the actual <a> click so jsdom doesn't try to navigate.
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const onToast = vi.fn()
    const user = userEvent.setup()
    render(<DiagnosticsPanel onToast={onToast} />)

    // Wait for backfill so the bundle has actual content.
    await waitFor(() => {
      expect(screen.getByText('Tick complete')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('diag-export-btn'))

    expect(createObjectURLSpy).toHaveBeenCalledOnce()
    const blobArg = createObjectURLSpy.mock.calls[0][0] as Blob
    expect(blobArg.type).toBe('application/json')
    // jsdom's Blob has unreliable `.text()` and `Response(blob)` semantics,
    // so we don't try to inspect the body bytes here. We instead assert the
    // Blob is non-empty (proving JSON.stringify ran successfully on the
    // bundle) and that the download path fired end-to-end.
    expect(blobArg.size).toBeGreaterThan(0)
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(onToast).toHaveBeenCalledWith('Diagnostic bundle downloaded', 'success')

    // Allow the deferred revokeObjectURL to fire.
    await new Promise((r) => setTimeout(r, 5))
    expect(revokeObjectURLSpy).toHaveBeenCalled()
  })
})
