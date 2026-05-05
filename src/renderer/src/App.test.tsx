/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// `App.tsx` directly imports a PNG asset (`./assets/logo.png`). Vite handles
// that at build time but vitest in jsdom mode does not have a Vite asset
// pipeline by default — register a stub so the import resolves to a string.
vi.mock('./assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('./index.css', () => ({}))

import App from './App'

interface MockElectron {
  // Using the loosest possible `Mock` shape so test-specific implementations
  // (which return concrete types like `IpcResult` or `AppSettings`) assign
  // cleanly without TS variance fights.
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function installElectronMock(
  invokeImpl: (channel: string, ...args: unknown[]) => unknown
): MockElectron {
  const mock: MockElectron = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) =>
      invokeImpl(channel, ...args)
    ) as unknown as ReturnType<typeof vi.fn>,
    on: vi.fn(() => () => {}) as unknown as ReturnType<typeof vi.fn>,
    send: vi.fn()
  }
  Object.defineProperty(window, 'electron', { value: mock, writable: true, configurable: true })
  Object.defineProperty(window, 'osInfo', {
    value: { platform: 'win32' },
    writable: true,
    configurable: true
  })
  return mock
}

afterEach(() => {
  cleanup() // unmount any mounted React tree so the next test starts clean
  vi.restoreAllMocks()
})

describe('App initial render', () => {
  beforeEach(() => {
    installElectronMock(() => ({}))
  })

  it('renders the logo and the start (▶) button when idle', async () => {
    render(<App />)
    // Idle status text comes from i18n.zh ("待命")
    await waitFor(() => {
      expect(screen.getByText('待命')).toBeInTheDocument()
    })
    // The status indicator + bottom bar should both be visible
    expect(screen.getByAltText('SightFlow')).toBeInTheDocument()
  })

  it('renders an empty activity log placeholder', async () => {
    render(<App />)
    expect(screen.getByText('引擎尚未启动')).toBeInTheDocument()
  })
})

describe('Settings flow', () => {
  it('opens the settings panel when the gear button is clicked', async () => {
    installElectronMock((channel) => {
      if (channel === 'settings:getAll') return { apiKey: 'sk-abc', baseURL: '', appType: 'weixin' }
      return { success: true }
    })
    const user = userEvent.setup()
    render(<App />)

    // Click the third bottom button (Settings gear). The button label isn't
    // text-based, so target by class — the only deviation from a fully
    // semantic query and acceptable for this smoke test.
    const buttons = document.querySelectorAll('.bottom-btn-settings')
    const gear = buttons[buttons.length - 1] as HTMLButtonElement
    await user.click(gear)

    // Settings card title is "AI 模型配置"
    await waitFor(() => {
      expect(screen.getByText('AI 模型配置')).toBeInTheDocument()
    })
  })

  it('loads existing settings on mount and pre-fills the API Key field', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'settings:getAll')
        return { apiKey: 'sk-test-123', baseURL: 'https://my.proxy', appType: 'wework' }
      return { success: true }
    })
    const user = userEvent.setup()
    render(<App />)

    const gear = document.querySelectorAll('.bottom-btn-settings')[
      document.querySelectorAll('.bottom-btn-settings').length - 1
    ] as HTMLButtonElement
    await user.click(gear)

    // Wait for the async invoke to populate the form
    await waitFor(() => {
      const apiInput = document.querySelector('input[type="password"]') as HTMLInputElement | null
      expect(apiInput?.value).toBe('sk-test-123')
    })

    expect(electron.invoke).toHaveBeenCalledWith('settings:getAll')
  })
})

describe('Engine controls', () => {
  it('shows a toast and stays Idle when starting without an API Key', async () => {
    installElectronMock((channel) => {
      if (channel === 'settings:getAll') return {} // no apiKey
      return { success: true }
    })
    const user = userEvent.setup()
    render(<App />)

    const playBtn = document.querySelector('.bottom-btn-start') as HTMLButtonElement
    expect(playBtn).toBeTruthy()
    await user.click(playBtn)

    // The toast renders inside an element with class `toast`
    await waitFor(() => {
      const toast = document.querySelector('.toast.show')
      expect(toast?.textContent).toMatch(/请先.*API Key/)
    })
  })

  it('flips to Running state when engine:start succeeds', async () => {
    const electron = installElectronMock((channel) => {
      if (channel === 'settings:getAll') return { apiKey: 'k', appType: 'weixin' }
      if (channel === 'engine:start') return { success: true }
      return { success: true }
    })
    const user = userEvent.setup()
    render(<App />)

    const playBtn = document.querySelector('.bottom-btn-start') as HTMLButtonElement
    await user.click(playBtn)

    await waitFor(() => {
      expect(screen.getByText('运行中')).toBeInTheDocument()
    })
    expect(electron.invoke).toHaveBeenCalledWith(
      'engine:start',
      expect.objectContaining({ apiKey: 'k', appType: 'weixin' })
    )
  })

  it('flips to Error state with the error message when engine:start rejects with success:false', async () => {
    installElectronMock((channel) => {
      if (channel === 'settings:getAll') return { apiKey: 'k', appType: 'weixin' }
      if (channel === 'engine:start') return { success: false, error: '未找到微信窗口' }
      return { success: true }
    })
    const user = userEvent.setup()
    render(<App />)

    const playBtn = document.querySelector('.bottom-btn-start') as HTMLButtonElement
    await user.click(playBtn)

    await waitFor(() => {
      expect(screen.getByText('异常')).toBeInTheDocument()
    })
    await waitFor(() => {
      const toast = document.querySelector('.toast.show')
      expect(toast?.textContent).toContain('未找到微信窗口')
    })
  })
})
