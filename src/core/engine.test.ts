import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine } from './engine'
import type { AgentHooks, ReplyAction } from './hooks'
import type { DesktopDevice } from './device'
import type { AppType } from './rpa/types'
import { Lifecycle, type LifecycleEvent } from './runtime'
import type { AgentBrain, BrainContext, BrainStream } from './brain'

/**
 * Build an in-memory `DesktopDevice` whose behaviour can be programmed per
 * test. Each method writes into a shared `calls` log so we can assert the
 * exact sequence of orchestration calls Engine made.
 */
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

function makeFakeDevice(state: FakeDeviceState): DesktopDevice & {
  state: FakeDeviceState
} {
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

/**
 * Hooks fake that yields a programmable list of `ReplyAction` items each
 * time `getReply` is called. Suitable for driving Engine's main loop with
 * a deterministic transcript.
 */
function makeFakeHooks(
  options: { onEngineStart?: () => Promise<void>; onEngineStop?: () => Promise<void> } = {}
): AgentHooks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    onEngineStart: async () => {
      calls.push('onEngineStart')
      await options.onEngineStart?.()
    },
    onEngineStop: async () => {
      calls.push('onEngineStop')
      await options.onEngineStop?.()
    },
    onActionComplete: (action, result) => {
      calls.push(`onActionComplete(${action.type}=${result.success})`)
    },
    onError: (err, phase) => {
      calls.push(`onError(${phase}:${err.message})`)
    }
  }
}

/**
 * Translate the legacy `ReplyAction` test fixtures (still expressive and
 * widely used across these tests) into the Phase 2 `BrainStream` shape.
 * `image` is dropped (engine no longer handles it; pre-Phase-2 it was a
 * TODO no-op anyway).
 */
function replyActionToStream(action: ReplyAction): BrainStream {
  switch (action.type) {
    case 'text':
      return { decision: { type: 'reply', text: action.content } }
    case 'skip':
      return { decision: { type: 'skip' } }
    case 'thinking':
      return { thinking: action.content }
    case 'image':
      return {} // dropped; existing tests don't exercise this branch
  }
}

/**
 * Drives `Engine.processCurrentChat` with a deterministic sequence of
 * decisions. `scripts[0]` is consumed on the first `decide()` call,
 * `scripts[1]` on the second, etc. Recording `calls` parallels the
 * `makeFakeHooks` transcript so existing assertions keep working.
 */
function makeFakeBrain(
  scripts: ReplyAction[][]
): AgentBrain & { calls: string[]; decideCount: number } {
  const calls: string[] = []
  let decideCount = 0
  return {
    calls,
    get decideCount() {
      return decideCount
    },
    decide: async function* (ctx: BrainContext): AsyncIterable<BrainStream> {
      calls.push(`decide(screenshot=${ctx.screenshot.slice(0, 20)})`)
      const next = scripts[decideCount] ?? []
      decideCount++
      for (const action of next) yield replyActionToStream(action)
    },
    testConnection: async () => ({ success: true }),
    updateConfig: () => {}
  }
}

// All tests use fake timers so we never actually wait the 3-5s polling delays.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Engine lifecycle — startup failures', () => {
  it('aborts cleanly when measureLayout fails and emits an error log', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: false, error: '未找到微信窗口' },
      hasUnreadQueue: [],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [],
      screenshotResult: 'data:image/png;base64,X',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([])
    const hooks = makeFakeHooks()
    const logs: Array<[string, string]> = []

    const engine = new Engine(brain, device, hooks, (type, content) => logs.push([type, content]))
    await engine.start()

    expect(state.calls).toEqual(['measureLayout'])
    expect(hooks.calls).toEqual(['onEngineStart', 'onEngineStop'])
    expect(engine.isRunning()).toBe(false)
    // Renderer log should mention "引擎无法启动" so the UI can flip to error state.
    const errorEntry = logs.find(([t, c]) => t === 'error' && c.includes('引擎无法启动'))
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.[1]).toContain('未找到微信窗口')
  })
})

describe('Engine main loop — single cycle', () => {
  it('runs measure → screenshot → reply → setBaseline → polls → exits on stop()', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }, { hasUnread: false }, { hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [
        { hasDiff: false, hasBaseline: true },
        { hasDiff: false, hasBaseline: true }
      ],
      screenshotResult: 'data:image/png;base64,frame1',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([[{ type: 'text', content: 'hi back' }]])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const startPromise = engine.start()

    // Let measure + first reply cycle complete. The loop then enters
    // waitForNextUnread and starts polling — we stop it after a few cycles.
    await vi.advanceTimersByTimeAsync(50)
    // Advance enough to cover at least one full polling iteration (3-5s + some).
    await vi.advanceTimersByTimeAsync(6000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(6000)
    await startPromise

    // Required ordering: measureLayout → screenshot → sendMessage → setChatBaseline
    const idx = (s: string): number => state.calls.findIndex((c) => c.startsWith(s))
    expect(idx('measureLayout')).toBe(0)
    expect(idx('screenshot')).toBeGreaterThan(idx('measureLayout'))
    expect(idx('sendMessage(hi back)')).toBeGreaterThan(idx('screenshot'))
    expect(idx('setChatBaseline')).toBeGreaterThan(idx('sendMessage(hi back)'))

    // Hooks lifecycle was honored
    expect(hooks.calls[0]).toBe('onEngineStart')
    expect(hooks.calls).toContain('onActionComplete(text=true)')
    expect(hooks.calls[hooks.calls.length - 1]).toBe('onEngineStop')

    // stop() called clearChatBaseline
    expect(state.calls).toContain('clearChatBaseline')
  })

  it('skips sendMessage when hooks yield {type:"skip"}', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      screenshotResult: 'X',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([[{ type: 'skip' }]])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(6000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(6000)
    await p

    expect(state.calls.find((c) => c.startsWith('sendMessage'))).toBeUndefined()
    // setChatBaseline still runs even when reply was skipped
    expect(state.calls).toContain('setChatBaseline')
  })
})

describe('Engine waitForNextUnread — diff channel', () => {
  it('returns to processCurrentChat when chatMainArea diff fires', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      // First poll: no diff. Second poll: diff fires → loop re-enters processCurrentChat.
      hasChatAreaChangedQueue: [
        { hasDiff: false, hasBaseline: true },
        { hasDiff: true, hasBaseline: true }
      ],
      isContactUnreadQueue: [],
      screenshotResult: 'X',
      calls: []
    }
    const device = makeFakeDevice(state)
    // Two reply cycles: first sends a message, second cycle (after diff) sends another.
    const brain = makeFakeBrain([
      [{ type: 'text', content: 'reply1' }],
      [{ type: 'text', content: 'reply2' }]
    ])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const p = engine.start()
    // Allow many polling rounds to complete.
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(20_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    expect(state.calls).toContain('sendMessage(reply1)')
    expect(state.calls).toContain('sendMessage(reply2)')
  })
})

describe('Engine waitForNextUnread — unread red-dot channel', () => {
  it('clicks the red-dot region, then the contact, when both detections succeed', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      // First diff poll says no change. Then unread fires.
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      hasUnreadQueue: [
        {
          hasUnread: true,
          chatEntranceArea: { bbox: [10, 10, 50, 50], coordinates: [123, 456] }
        }
      ],
      isContactUnreadQueue: [{ isUnread: true, firstContactCoords: [200, 300] }],
      screenshotResult: 'X',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([
      [{ type: 'text', content: 'r1' }],
      [{ type: 'text', content: 'r2' }]
    ])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(15_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    // Required ordering: red dot click → contact click → screenshot for new contact
    const reverseIdx = (needle: string): number =>
      state.calls
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.includes(needle))
        .slice(-1)[0]?.i ?? -1
    const dotIdx = reverseIdx('activeUnreadByClick')
    const clickIdx = reverseIdx('clickUnreadContact(200,300)')
    expect(dotIdx).toBeGreaterThanOrEqual(0)
    expect(clickIdx).toBeGreaterThan(dotIdx)
    expect(state.calls).toContain('clearChatBaseline')
  })

  it('clears VLM cache after 3 consecutive contact-detect failures', async () => {
    // Each "failure round" inside waitForNextUnread consumes:
    //   - 1 hasChatAreaChanged (no diff)
    //   - 2 hasUnreadMessage  (initial + recheck — both must return true)
    //   - 2 isChatContactUnread (initial + after re-click — both fail)
    // After 3 such rounds, consecutiveUnreadFailures hits 3 → clearUnreadCache.
    // Then there's a post-clear retry sequence that consumes a couple more.
    const stillUnread = {
      hasUnread: true,
      chatEntranceArea: {
        bbox: [0, 0, 10, 10] as [number, number, number, number],
        coordinates: [1, 1] as [number, number]
      }
    }
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasChatAreaChangedQueue: Array(10).fill({ hasDiff: false, hasBaseline: true }),
      // 3 rounds × 2 calls each + final-retry call after cache clear = 7. Pad
      // generously for safety.
      hasUnreadQueue: Array(15).fill(stillUnread),
      isContactUnreadQueue: Array(15).fill({ isUnread: false }),
      screenshotResult: 'X',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([[{ type: 'skip' }]])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(60_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    // The whole point: clearUnreadCache must have been called at least once.
    expect(state.calls).toContain('clearUnreadCache')
  })
})

describe('Engine.executeAction', () => {
  it('continues running after a sendMessage failure (logs error, calls onError)', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      screenshotResult: 'X',
      sendMessageError: new Error('boom'),
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([[{ type: 'text', content: 'will fail' }]])
    const hooks = makeFakeHooks()

    const engine = new Engine(brain, device, hooks)
    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(6_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(6_000)
    await p

    // sendMessage was attempted
    expect(state.calls).toContain('sendMessage(will fail)')
    // onError was invoked with phase=execute_action
    expect(hooks.calls.some((c) => c.startsWith('onError(execute_action:'))).toBe(true)
    // Engine reached final onEngineStop, i.e. the loop didn't crash out unexpectedly
    expect(hooks.calls[hooks.calls.length - 1]).toBe('onEngineStop')
  })
})

describe('Engine.setAppType', () => {
  it('delegates to device.setAppType (public API used by IPC layer)', () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [],
      screenshotResult: '',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([])
    const hooks = makeFakeHooks()
    const engine = new Engine(brain, device, hooks)

    engine.setAppType('wework')
    expect(state.calls).toContain('setAppType(wework)')
  })
})

describe('Engine.lifecycle integration', () => {
  it('drives the injected Lifecycle through idle → running → stopped on a clean run', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [],
      screenshotResult: '',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([])
    const hooks = makeFakeHooks()
    const lifecycle = new Lifecycle()
    const events: LifecycleEvent[] = []
    lifecycle.subscribe((e) => events.push(e))

    const engine = new Engine(brain, device, hooks, undefined, lifecycle)
    expect(lifecycle.getState()).toBe('idle')

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(lifecycle.getState()).toBe('running')

    await vi.advanceTimersByTimeAsync(60_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await p

    expect(lifecycle.getState()).toBe('stopped')
    const transitions = events.map((e) => `${e.from}->${e.to}`)
    expect(transitions).toEqual(['idle->running', 'running->stopped'])
  })

  it('crashes the lifecycle when measureLayout fails (no transition to stopped)', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: false, error: 'no window' },
      hasUnreadQueue: [],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [],
      screenshotResult: '',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([])
    const hooks = makeFakeHooks()
    const lifecycle = new Lifecycle()
    const events: LifecycleEvent[] = []
    lifecycle.subscribe((e) => events.push(e))

    const engine = new Engine(brain, device, hooks, undefined, lifecycle)
    await engine.start()

    expect(lifecycle.getState()).toBe('crashed')
    const transitions = events.map((e) => `${e.from}->${e.to}`)
    expect(transitions).toEqual(['idle->running', 'running->crashed'])
    expect(lifecycle.snapshot().lastError?.message).toBe('no window')
  })

  it('double-start is a no-op (idempotent guard at the boolean and FSM layer)', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [],
      screenshotResult: '',
      calls: []
    }
    const device = makeFakeDevice(state)
    const brain = makeFakeBrain([])
    const hooks = makeFakeHooks()
    const lifecycle = new Lifecycle()
    const engine = new Engine(brain, device, hooks, undefined, lifecycle)

    const p1 = engine.start()
    await vi.advanceTimersByTimeAsync(10)
    // Second start must NOT throw IllegalTransitionError from FSM.
    await expect(engine.start()).resolves.toBeUndefined()
    expect(lifecycle.getState()).toBe('running')

    engine.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    await p1
  })
})

describe('Engine.brain integration', () => {
  it('routes BrainStream.thinking events through emitLog(thinking) before the decision lands', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      screenshotResult: 'frame-A',
      calls: []
    }
    const device = makeFakeDevice(state)

    // A purpose-built brain that yields an explicit thinking step before the
    // reply, so we can assert ordering against the engine's renderer log.
    const customBrain: AgentBrain = {
      decide: async function* (): AsyncIterable<BrainStream> {
        yield { thinking: 'considering options...' }
        yield { thinking: 'narrowing in...' }
        yield { decision: { type: 'reply', text: 'final answer' } }
      },
      testConnection: async () => ({ success: true }),
      updateConfig: () => {}
    }
    const hooks = makeFakeHooks()
    const logs: Array<[string, string]> = []

    const engine = new Engine(customBrain, device, hooks, (type, content) =>
      logs.push([type, content])
    )
    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(6_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(6_000)
    await p

    const ordered = logs.map(([t, c]) => `${t}:${c}`)
    const consideringIdx = ordered.findIndex((s) => s.includes('considering'))
    const narrowingIdx = ordered.findIndex((s) => s.includes('narrowing'))
    const replyIdx = ordered.findIndex((s) => s.startsWith('reply:'))
    expect(consideringIdx).toBeGreaterThan(-1)
    expect(narrowingIdx).toBeGreaterThan(consideringIdx)
    expect(replyIdx).toBeGreaterThan(narrowingIdx)
    expect(state.calls).toContain('sendMessage(final answer)')
  })

  it('passes the engine appType through BrainContext (post-setAppType)', async () => {
    const state: FakeDeviceState = {
      measureLayoutResult: { success: true },
      hasUnreadQueue: [{ hasUnread: false }],
      isContactUnreadQueue: [],
      hasChatAreaChangedQueue: [{ hasDiff: false, hasBaseline: true }],
      screenshotResult: 'frame',
      calls: []
    }
    const device = makeFakeDevice(state)

    const seenAppTypes: AppType[] = []
    const customBrain: AgentBrain = {
      decide: async function* (ctx: BrainContext): AsyncIterable<BrainStream> {
        seenAppTypes.push(ctx.appType)
        yield { decision: { type: 'skip', reason: 'noop' } }
      },
      testConnection: async () => ({ success: true }),
      updateConfig: () => {}
    }
    const hooks = makeFakeHooks()
    const engine = new Engine(customBrain, device, hooks)
    engine.setAppType('wework')

    const p = engine.start()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(6_000)
    engine.stop()
    await vi.advanceTimersByTimeAsync(6_000)
    await p

    expect(seenAppTypes[0]).toBe('wework')
  })
})
