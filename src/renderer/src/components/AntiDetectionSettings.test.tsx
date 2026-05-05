/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AntiDetectionSettings } from './AntiDetectionSettings'
import { setLocale } from '../i18n'
import { renderWithProviders } from '../test-utils'

// PR2 wraps AntiDetectionSettings in a QueryClientProvider since the
// component now uses `useQuery` / `useMutation` for every IPC call. Use the
// shared `renderWithProviders` helper from `test-utils` instead of bare
// `render()` — each call constructs a fresh QueryClient so cache state from
// a previous test cannot leak in.
const render = renderWithProviders

vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('../index.css', () => ({}))

// All assertions in this file rely on the English copy so they remain
// stable regardless of the global default locale (which is 'zh' in
// production). Same convention DiagnosticsPanel.test.tsx uses.
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
  emit: (channel: string, payload: unknown) => void
}

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

// ── Fixtures ────────────────────────────────────────────────────────────────

interface AntiDetectionConfigShape {
  humanizer: {
    enabled: boolean
    preActionDelayMs: [number, number]
    postActionDelayMs: [number, number]
    clickJitterPx: number
    charsPerSecond: [number, number]
    punctuationPauseMs: [number, number]
    typoProbability: number
    longPauseProbability: number
    longPauseMs: [number, number]
    readDelayMs: [number, number]
  }
  rateLimiter: {
    enabled: boolean
    globalPerHour: number
    perContactPerDay: number
    minIntervalMs: number
    newContactCooldownMs: number
  }
  schedule: {
    enabled: boolean
    windows: Record<string, Array<[string, string]>>
    afkProbability: number
    afkDurationMs: [number, number]
  }
  circuitBreaker: {
    enabled: boolean
    consecutiveAiFailures: number
    consecutiveRpaFailures: number
    duplicateReplyCount: number
    screenshotFreezeMs: number
    bannedKeywords: string[]
  }
  ocr: {
    enabled: boolean
    sampleIntervalMs: number
    language: string
  }
}

const DEFAULT_CONFIG: AntiDetectionConfigShape = {
  humanizer: {
    enabled: true,
    preActionDelayMs: [80, 220],
    postActionDelayMs: [200, 500],
    clickJitterPx: 2,
    charsPerSecond: [4, 8],
    punctuationPauseMs: [100, 300],
    typoProbability: 0.02,
    longPauseProbability: 0.05,
    longPauseMs: [1500, 4000],
    readDelayMs: [400, 1500]
  },
  rateLimiter: {
    enabled: true,
    globalPerHour: 30,
    perContactPerDay: 20,
    minIntervalMs: 8000,
    newContactCooldownMs: 60000
  },
  schedule: {
    enabled: false,
    windows: {},
    afkProbability: 0.05,
    afkDurationMs: [30000, 180000]
  },
  circuitBreaker: {
    enabled: true,
    consecutiveAiFailures: 5,
    consecutiveRpaFailures: 3,
    duplicateReplyCount: 3,
    screenshotFreezeMs: 300000,
    bannedKeywords: ['账号异常', '冻结', '违规']
  },
  ocr: {
    enabled: false,
    sampleIntervalMs: 30000,
    language: 'chi_sim+eng'
  }
}

function untrippedSnapshot(config: AntiDetectionConfigShape): unknown {
  return {
    config,
    rateLimiter: {
      hourly: { used: 0, max: config.rateLimiter.globalPerHour, resetAt: 0 },
      perContact: {},
      lastSendAt: 0
    },
    schedule: { awake: true, nextAwakeAt: null },
    circuitBreaker: {
      state: { tripped: false },
      consecutiveAiFailures: 0,
      consecutiveRpaFailures: 0
    }
  }
}

function trippedSnapshot(config: AntiDetectionConfigShape, reason: string): unknown {
  return {
    config,
    rateLimiter: {
      hourly: { used: 0, max: config.rateLimiter.globalPerHour, resetAt: 0 },
      perContact: {},
      lastSendAt: 0
    },
    schedule: { awake: true, nextAwakeAt: null },
    circuitBreaker: {
      state: { tripped: true, reason, detail: 'd', at: 1 },
      consecutiveAiFailures: 5,
      consecutiveRpaFailures: 0
    }
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AntiDetectionSettings — initial render', () => {
  it('renders all four section titles after policy:get resolves', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })

    render(<AntiDetectionSettings />)

    await waitFor(() => {
      expect(screen.getByText('Humanizer')).toBeInTheDocument()
    })
    expect(screen.getByText('Rate limiter')).toBeInTheDocument()
    expect(screen.getByText('Schedule')).toBeInTheDocument()
    expect(screen.getByText('Circuit breaker')).toBeInTheDocument()
  })

  it('populates inputs with values returned by policy:get', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })

    render(<AntiDetectionSettings />)

    await waitFor(() => {
      expect(screen.getByTestId('rl-global')).toBeInTheDocument()
    })
    expect((screen.getByTestId('rl-global') as HTMLInputElement).value).toBe('30')
    expect((screen.getByTestId('rl-per-contact') as HTMLInputElement).value).toBe('20')
    expect((screen.getByTestId('hum-pre-min') as HTMLInputElement).value).toBe('80')
    expect((screen.getByTestId('hum-pre-max') as HTMLInputElement).value).toBe('220')
  })
})

describe('AntiDetectionSettings — edit & save flow', () => {
  it('updates local state on edit but does not call policy:set until Save', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })
    const user = userEvent.setup()

    render(<AntiDetectionSettings />)

    const input = (await screen.findByTestId('rl-global')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '42')

    expect(input.value).toBe('42')
    // Only the two backfill calls (policy:get / policy:snapshot) so far.
    const setCalls = (electron.invoke.mock.calls as unknown[][]).filter(
      (c) => c[0] === 'policy:set'
    )
    expect(setCalls.length).toBe(0)
  })

  it('calls policy:set with the full config on Save and toasts on success', async () => {
    const electron = installElectronMock((channel, payload?: unknown) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      if (channel === 'policy:set') {
        // Echo the patch back so the local state reconciles cleanly.
        return { success: true, config: payload ?? DEFAULT_CONFIG }
      }
      return null
    })
    const onToast = vi.fn()
    const user = userEvent.setup()

    render(<AntiDetectionSettings onToast={onToast} />)
    await screen.findByTestId('rl-global')

    await user.click(screen.getByTestId('policy-save'))

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith('Anti-detection settings saved', 'success')
    })

    const setCalls = (electron.invoke.mock.calls as unknown[][]).filter(
      (c) => c[0] === 'policy:set'
    )
    expect(setCalls.length).toBe(1)
    const payload = setCalls[0][1] as AntiDetectionConfigShape
    // Full-config payload is sent (all four blocks present).
    expect(payload.humanizer).toBeDefined()
    expect(payload.rateLimiter.globalPerHour).toBe(30)
    expect(payload.schedule).toBeDefined()
    expect(payload.circuitBreaker.bannedKeywords).toEqual(['账号异常', '冻结', '违规'])
  })

  it('shows an error toast and preserves local edits when policy:set fails', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      if (channel === 'policy:set') return { success: false, error: 'persistence offline' }
      return null
    })
    const onToast = vi.fn()
    const user = userEvent.setup()

    render(<AntiDetectionSettings onToast={onToast} />)
    const input = (await screen.findByTestId('rl-global')) as HTMLInputElement
    await user.clear(input)
    await user.type(input, '99')

    await user.click(screen.getByTestId('policy-save'))

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('Save failed'), 'error')
    })
    // Local edit survives the rejection — the user can fix the underlying
    // problem and try again without retyping.
    expect(input.value).toBe('99')
  })
})

describe('AntiDetectionSettings — breaker banner', () => {
  it('hides the banner when the snapshot reports tripped:false', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return untrippedSnapshot(DEFAULT_CONFIG)
      return null
    })

    render(<AntiDetectionSettings />)
    await screen.findByTestId('rl-global')

    expect(screen.queryByTestId('policy-breaker-banner')).not.toBeInTheDocument()
  })

  it('shows the banner when tripped, and Reset breaker re-fetches the snapshot', async () => {
    let snapshotResponse: unknown = trippedSnapshot(DEFAULT_CONFIG, 'duplicateReply')
    const electron = installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return snapshotResponse
      if (channel === 'policy:resetBreaker') {
        // Subsequent snapshot calls return the cleared state.
        snapshotResponse = untrippedSnapshot(DEFAULT_CONFIG)
        return { success: true }
      }
      return null
    })
    const onToast = vi.fn()
    const user = userEvent.setup()

    render(<AntiDetectionSettings onToast={onToast} />)

    await waitFor(() => {
      expect(screen.getByTestId('policy-breaker-banner')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('policy-reset-breaker'))

    await waitFor(() => {
      expect(screen.queryByTestId('policy-breaker-banner')).not.toBeInTheDocument()
    })
    const channels = (electron.invoke.mock.calls as unknown[][]).map((c) => c[0] as string)
    expect(channels).toContain('policy:resetBreaker')
    // At least 2 snapshot calls: initial backfill + post-reset refetch.
    // PR2 swapped manual `await refreshSnapshot()` for
    // `invalidateQueries(['policy:snapshot'])` plus a 2-second
    // `refetchInterval`, so under load the suite can occasionally observe
    // a third polling-driven call. The behavioural contract is "≥2".
    expect(channels.filter((c) => c === 'policy:snapshot').length).toBeGreaterThanOrEqual(2)
    expect(onToast).toHaveBeenCalledWith('Breaker reset', 'success')
  })
})

describe('AntiDetectionSettings — OCR section', () => {
  it('renders the OCR section heading and toggles enabled', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })
    const user = userEvent.setup()

    render(<AntiDetectionSettings />)

    await waitFor(() => {
      expect(screen.getByText('OCR popup detection')).toBeInTheDocument()
    })

    const toggle = screen.getByTestId('ocr-enabled') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    await user.click(toggle)
    expect(toggle.checked).toBe(true)
  })
})

describe('AntiDetectionSettings — presets & validation', () => {
  it('Conservative preset sets rateLimiter.globalPerHour to 15', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })
    const user = userEvent.setup()

    render(<AntiDetectionSettings />)
    await screen.findByTestId('rl-global')

    await user.click(screen.getByTestId('policy-preset-conservative'))

    await waitFor(() => {
      expect((screen.getByTestId('rl-global') as HTMLInputElement).value).toBe('15')
    })
    expect((screen.getByTestId('rl-min-interval') as HTMLInputElement).value).toBe('12000')
  })

  it('flags an inverted range with an inline error and disables Save', async () => {
    installElectronMock((channel) => {
      if (channel === 'policy:get') return DEFAULT_CONFIG
      if (channel === 'policy:snapshot') return null
      return null
    })
    const user = userEvent.setup()

    render(<AntiDetectionSettings />)
    const min = (await screen.findByTestId('hum-pre-min')) as HTMLInputElement
    await user.clear(min)
    await user.type(min, '500')

    await waitFor(() => {
      expect(screen.getByTestId('hum-pre-error')).toBeInTheDocument()
    })
    expect((screen.getByTestId('policy-save') as HTMLButtonElement).disabled).toBe(true)
  })
})
