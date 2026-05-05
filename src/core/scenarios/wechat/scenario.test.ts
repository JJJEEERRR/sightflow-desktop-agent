// src/core/scenarios/wechat/scenario.test.ts
// Phase 4 — Scenarios: WechatScenario unit tests.
//
// Covers the WeChat-specific orchestration that previously lived inside
// engine.test.ts (red-dot detection, double-channel polling, the
// consecutive-failure → clearUnreadCache fallback) and the new wiring of
// the Scenario interface (`measureLayout` / `screenshot` / `setChat
// Baseline` / `clearChatBaseline` / `execute` / `waitForNextChat`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Jimp } from 'jimp'
import { WechatScenario } from './scenario'
import type { Scenario, ScenarioHelpers } from '../types'
import type { DesktopDevice } from '../../device'
import type { AgentHooks } from '../../hooks'
import type { AppType } from '../../rpa/types'
import type { ActionDescriptor, AntiDetectionPolicy } from '../../policy'

/**
 * Build a deterministic PNG data URL of the given size and uniform color.
 * Used by `getContactId` tests so the resulting hash is stable across runs.
 */
async function makePngDataUrl(
  width: number,
  height: number,
  color: number = 0xff0000ff
): Promise<string> {
  const img = new Jimp({ width, height, color })
  const buf = await img.getBuffer('image/png')
  return `data:image/png;base64,${buf.toString('base64')}`
}

interface FakeDeviceState {
  measureLayoutResult: { success: boolean; error?: string }
  hasUnreadQueue: Array<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: [number, number, number, number]; coordinates: [number, number] }
  }>
  isContactUnreadQueue: Array<{ isUnread: boolean; firstContactCoords?: [number, number] }>
  hasChatAreaChangedQueue: Array<{ hasDiff: boolean; hasBaseline: boolean }>
  screenshotResult: string
  sendMessageError?: Error
  calls: string[]
}

function makeFakeDevice(state: FakeDeviceState): DesktopDevice & { state: FakeDeviceState } {
  const log = (s: string): void => {
    state.calls.push(s)
  }
  return {
    state,
    setAppType: (t: AppType) => log(`setAppType(${t})`),
    setApiKey: (_k: string) => log('setApiKey'),
    measureLayout: async () => {
      log('measureLayout')
      return state.measureLayoutResult
    },
    screenshot: async () => {
      log('screenshot')
      return state.screenshotResult
    },
    hasUnreadMessage: async () => {
      log('hasUnreadMessage')
      return state.hasUnreadQueue.shift() ?? { hasUnread: false }
    },
    isChatContactUnread: async () => {
      log('isChatContactUnread')
      return state.isContactUnreadQueue.shift() ?? { isUnread: false }
    },
    clearUnreadCache: () => log('clearUnreadCache'),
    setChatBaseline: async () => {
      log('setChatBaseline')
      return true
    },
    hasChatAreaChanged: async () => {
      log('hasChatAreaChanged')
      return state.hasChatAreaChangedQueue.shift() ?? { hasDiff: false, hasBaseline: false }
    },
    clearChatBaseline: () => log('clearChatBaseline'),
    sendMessage: async (text: string) => {
      log(`sendMessage(${text})`)
      if (state.sendMessageError) throw state.sendMessageError
    },
    activeUnreadByClick: async (c) => log(`activeUnreadByClick(${c[0]},${c[1]})`),
    clickUnreadContact: async (c) => log(`clickUnreadContact(${c[0]},${c[1]})`),
    clickAt: async (x, y) => log(`clickAt(${x},${y})`)
  }
}

interface HelperRecorder {
  helpers: ScenarioHelpers
  emitted: Array<[string, string]>
  hooks: AgentHooks & { calls: string[] }
}

function makeHelpers(opts: { policy?: AntiDetectionPolicy } = {}): HelperRecorder {
  const emitted: Array<[string, string]> = []
  const hookCalls: string[] = []
  const hooks: AgentHooks & { calls: string[] } = {
    calls: hookCalls,
    onActionComplete: (action, result) => {
      hookCalls.push(`onActionComplete(${action.type}=${result.success})`)
    },
    onError: (err, phase) => {
      hookCalls.push(`onError(${phase}:${err.message})`)
    }
  }
  return {
    emitted,
    hooks,
    helpers: {
      emitLog: (type, content) => emitted.push([type, content]),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      policy: opts.policy,
      hooks
    }
  }
}

function emptyDeviceState(overrides: Partial<FakeDeviceState> = {}): FakeDeviceState {
  return {
    measureLayoutResult: { success: true },
    hasUnreadQueue: [],
    isContactUnreadQueue: [],
    hasChatAreaChangedQueue: [],
    screenshotResult: 'data:image/png;base64,X',
    calls: [],
    ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('WechatScenario — thin device delegations', () => {
  it('measureLayout() forwards the device result verbatim', async () => {
    const state = emptyDeviceState({
      measureLayoutResult: { success: false, error: 'no window' }
    })
    const device = makeFakeDevice(state)
    const scenario: Scenario = new WechatScenario(device)

    const out = await scenario.measureLayout()

    expect(out).toEqual({ success: false, error: 'no window' })
    expect(state.calls).toEqual(['measureLayout'])
  })

  it('screenshot() returns the device screenshot string', async () => {
    const state = emptyDeviceState({ screenshotResult: 'data:image/png;base64,frame-Z' })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const out = await scenario.screenshot()

    expect(out).toBe('data:image/png;base64,frame-Z')
    expect(state.calls).toContain('screenshot')
  })

  it('setChatBaseline() / clearChatBaseline() delegate to the device', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    await scenario.setChatBaseline()
    scenario.clearChatBaseline()

    expect(state.calls).toEqual(['setChatBaseline', 'clearChatBaseline'])
  })

  it('setAppType() forwards to device.setAppType', () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    scenario.setAppType?.('wework')

    expect(state.calls).toEqual(['setAppType(wework)'])
  })
})

describe('WechatScenario.execute', () => {
  it('reply: calls device.sendMessage and reports onActionComplete', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()

    await scenario.execute({ type: 'reply', text: 'hi' }, recorder.helpers)

    expect(state.calls).toContain('sendMessage(hi)')
    expect(recorder.hooks.calls).toContain('onActionComplete(text=true)')
    // emitLog 'reply' fired before the send.
    expect(recorder.emitted[0][0]).toBe('reply')
  })

  it('reply: routes through policy.beforeAction / afterAction with success outcome', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const seq: string[] = []
    const policy = {
      beforeAction: async (a: { type: string }) => {
        seq.push(`before(${a.type})`)
        return {}
      },
      afterAction: async (a: { type: string }, outcome: { success: boolean }) => {
        seq.push(`after(${a.type}=${outcome.success})`)
      }
    } as unknown as AntiDetectionPolicy
    const recorder = makeHelpers({ policy })

    await scenario.execute({ type: 'reply', text: 'pong' }, recorder.helpers)

    expect(seq).toEqual(['before(reply)', 'after(reply=true)'])
    expect(state.calls).toContain('sendMessage(pong)')
  })

  it('reply: device.sendMessage throw → afterAction(success:false) and onError fires', async () => {
    const state = emptyDeviceState({ sendMessageError: new Error('rpa boom') })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const afters: Array<{ success: boolean }> = []
    const policy = {
      beforeAction: async () => ({}),
      afterAction: async (_a: unknown, outcome: { success: boolean }) => {
        afters.push(outcome)
      }
    } as unknown as AntiDetectionPolicy
    const recorder = makeHelpers({ policy })

    await scenario.execute({ type: 'reply', text: 'doomed' }, recorder.helpers)

    expect(afters).toHaveLength(1)
    expect(afters[0].success).toBe(false)
    expect(recorder.hooks.calls.some((c) => c.startsWith('onError(execute_action:'))).toBe(true)
    // Engine-level emit: 'error' event with the failure message
    expect(recorder.emitted.some(([t]) => t === 'error')).toBe(true)
  })

  it('skip: emits skip log and never touches the device', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()

    await scenario.execute({ type: 'skip', reason: 'not for me' }, recorder.helpers)

    expect(state.calls).toEqual([])
    expect(recorder.emitted[0]).toEqual(['skip', '跳过：not for me'])
  })

  it('reply: threads helpers.contactId into policy.beforeAction / afterAction', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const beforeSeen: Array<ActionDescriptor> = []
    const afterSeen: Array<ActionDescriptor> = []
    const policy = {
      beforeAction: async (a: ActionDescriptor) => {
        beforeSeen.push(a)
        return {}
      },
      afterAction: async (a: ActionDescriptor, _outcome: { success: boolean }) => {
        afterSeen.push(a)
      }
    } as unknown as AntiDetectionPolicy
    const recorder = makeHelpers({ policy })
    recorder.helpers.contactId = 'deadbeefcafe1234'

    await scenario.execute({ type: 'reply', text: 'hello' }, recorder.helpers)

    expect(beforeSeen).toHaveLength(1)
    expect(beforeSeen[0]).toEqual({
      type: 'reply',
      text: 'hello',
      contactId: 'deadbeefcafe1234'
    })
    expect(afterSeen).toHaveLength(1)
    expect(afterSeen[0]).toEqual({
      type: 'reply',
      text: 'hello',
      contactId: 'deadbeefcafe1234'
    })
  })

  it('reply: with no helpers.contactId, descriptors carry contactId:undefined (per-contact gate skips)', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const beforeSeen: Array<ActionDescriptor> = []
    const policy = {
      beforeAction: async (a: ActionDescriptor) => {
        beforeSeen.push(a)
        return {}
      },
      afterAction: async () => {}
    } as unknown as AntiDetectionPolicy
    const recorder = makeHelpers({ policy })
    // Intentionally NOT setting recorder.helpers.contactId.

    await scenario.execute({ type: 'reply', text: 'hi' }, recorder.helpers)

    expect(beforeSeen).toHaveLength(1)
    expect(beforeSeen[0]).toEqual({ type: 'reply', text: 'hi', contactId: undefined })
  })
})

describe('WechatScenario.getContactId', () => {
  it('returns a 16-character lowercase hex string for a non-empty PNG screenshot', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const screenshot = await makePngDataUrl(120, 200)

    const id = await scenario.getContactId?.(screenshot)

    expect(id).toBeDefined()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns the SAME id for two identical screenshots (stability)', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const screenshot = await makePngDataUrl(120, 200, 0x336699ff)

    const a = await scenario.getContactId?.(screenshot)
    const b = await scenario.getContactId?.(screenshot)

    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns DIFFERENT ids for screenshots with different header pixels', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    // Two PNGs with different uniform colors → header strip pixels differ
    // → SHA-256 of those bytes differs.
    const a = await scenario.getContactId?.(await makePngDataUrl(120, 200, 0xff0000ff))
    const b = await scenario.getContactId?.(await makePngDataUrl(120, 200, 0x00ff00ff))

    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(b).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
  })

  it('returns undefined on malformed input (does not throw)', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    // Random base64 garbage that is NOT a valid PNG.
    const id = await scenario.getContactId?.('data:image/png;base64,not-a-real-png-payload')

    expect(id).toBeUndefined()
  })
})

describe('WechatScenario.waitForNextChat', () => {
  it('exits promptly when running() returns false from the start', async () => {
    const state = emptyDeviceState()
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()

    // Mark "stopped" before the first iteration; the first sleep still
    // happens, but no device probing should follow.
    let live = true
    const running = (): boolean => live

    const p = scenario.waitForNextChat(running, recorder.helpers)
    live = false
    await vi.advanceTimersByTimeAsync(6000)
    await p

    // No detection ever ran because the guard tripped after the sleep.
    expect(state.calls.find((c) => c === 'hasChatAreaChanged')).toBeUndefined()
    expect(state.calls.find((c) => c === 'hasUnreadMessage')).toBeUndefined()
  })

  it('returns when chatMainArea diff fires (does not click red-dot path)', async () => {
    const state = emptyDeviceState({
      hasChatAreaChangedQueue: [{ hasDiff: true, hasBaseline: true }]
    })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()
    const running = (): boolean => true

    const p = scenario.waitForNextChat(running, recorder.helpers)
    await vi.advanceTimersByTimeAsync(6000)
    await p

    expect(state.calls).toContain('hasChatAreaChanged')
    // Red-dot path NOT taken — no hasUnreadMessage probe should fire.
    expect(state.calls.find((c) => c === 'hasUnreadMessage')).toBeUndefined()
    expect(
      recorder.emitted.some(([t, c]) => t === 'thinking' && c.includes('chatMainArea diff'))
    ).toBe(true)
  })

  it('returns after red-dot click + contact click on the happy path', async () => {
    const state = emptyDeviceState({
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      hasUnreadQueue: [
        {
          hasUnread: true,
          chatEntranceArea: { bbox: [10, 10, 50, 50], coordinates: [123, 456] }
        }
      ],
      isContactUnreadQueue: [{ isUnread: true, firstContactCoords: [200, 300] }]
    })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()
    const running = (): boolean => true

    const p = scenario.waitForNextChat(running, recorder.helpers)
    await vi.advanceTimersByTimeAsync(15_000)
    await p

    expect(state.calls).toContain('activeUnreadByClick(123,456)')
    expect(state.calls).toContain('clickUnreadContact(200,300)')
    // The newly-switched chat needs a fresh baseline → old one is dropped.
    expect(state.calls).toContain('clearChatBaseline')
  })

  it('clears VLM cache after 3 consecutive contact-detect failures', async () => {
    const stillUnread = {
      hasUnread: true,
      chatEntranceArea: {
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        coordinates: [1, 1] as [number, number]
      }
    }
    const state = emptyDeviceState({
      hasChatAreaChangedQueue: Array(20).fill({ hasDiff: false, hasBaseline: true }),
      hasUnreadQueue: Array(20).fill(stillUnread),
      // Keep returning false so the failure counter eventually trips.
      isContactUnreadQueue: Array(20).fill({ isUnread: false })
    })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    const recorder = makeHelpers()
    let live = true
    const running = (): boolean => live

    const p = scenario.waitForNextChat(running, recorder.helpers)
    // 3 polling rounds each take ~3-5s + 1500ms internal — pad generously.
    await vi.advanceTimersByTimeAsync(60_000)
    live = false
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    expect(state.calls).toContain('clearUnreadCache')
  })

  it('routes polling clicks (red dot, contact) through policy.beforeAction/afterAction', async () => {
    const state = emptyDeviceState({
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      hasUnreadQueue: [
        {
          hasUnread: true,
          chatEntranceArea: { bbox: [0, 0, 10, 10], coordinates: [50, 60] }
        }
      ],
      isContactUnreadQueue: [{ isUnread: true, firstContactCoords: [70, 80] }]
    })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)

    const beforeActions: Array<{ type: string; coords?: [number, number] }> = []
    const afterActions: Array<{ type: string; success: boolean }> = []
    const policy = {
      beforeAction: async (a: { type: string; coords?: [number, number] }) => {
        beforeActions.push(a)
        return {}
      },
      afterAction: async (a: { type: string }, outcome: { success: boolean }) => {
        afterActions.push({ type: a.type, success: outcome.success })
      }
    } as unknown as AntiDetectionPolicy
    const recorder = makeHelpers({ policy })
    const running = (): boolean => true

    const p = scenario.waitForNextChat(running, recorder.helpers)
    await vi.advanceTimersByTimeAsync(15_000)
    await p

    const clickActions = beforeActions.filter((a) => a.type === 'click')
    expect(clickActions.length).toBe(2)
    const coords = clickActions.map((a) => a.coords)
    expect(coords).toEqual([
      [50, 60],
      [70, 80]
    ])
    const clickAfters = afterActions.filter((a) => a.type === 'click')
    expect(clickAfters.length).toBe(2)
    expect(clickAfters.every((a) => a.success === true)).toBe(true)
  })

  it('falls back to ad-hoc sleep on polling clicks when no policy is configured', async () => {
    const state = emptyDeviceState({
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      hasUnreadQueue: [
        {
          hasUnread: true,
          chatEntranceArea: { bbox: [0, 0, 10, 10], coordinates: [33, 44] }
        }
      ],
      isContactUnreadQueue: [{ isUnread: true, firstContactCoords: [55, 66] }]
    })
    const device = makeFakeDevice(state)
    const scenario = new WechatScenario(device)
    // helpers without a policy
    const recorder = makeHelpers()
    const running = (): boolean => true

    const p = scenario.waitForNextChat(running, recorder.helpers)
    await vi.advanceTimersByTimeAsync(15_000)
    await p

    expect(state.calls).toContain('activeUnreadByClick(33,44)')
    expect(state.calls).toContain('clickUnreadContact(55,66)')
  })
})
