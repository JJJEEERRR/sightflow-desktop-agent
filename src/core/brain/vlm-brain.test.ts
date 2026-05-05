import { describe, expect, it, vi } from 'vitest'
import { VlmBrain, DEFAULT_REPLY_SYSTEM_PROMPT } from './vlm-brain'
import type { ChatProvider } from './providers/types'
import type { BrainContext, BrainStream } from './types'

interface FakeProviderState {
  callVisionResult: string | (() => string | Promise<string>)
  shouldThrow?: Error
  visionCalls: Array<{ system: string; user: string; image: string }>
  testConnectionResult: { success: boolean; error?: string }
  configUpdates: Array<unknown>
}

function makeFakeProvider(state: FakeProviderState): ChatProvider {
  return {
    async callVision(system: string, user: string, image: string): Promise<string> {
      state.visionCalls.push({ system, user, image })
      if (state.shouldThrow) throw state.shouldThrow
      const r = state.callVisionResult
      return typeof r === 'function' ? Promise.resolve(r()) : r
    },
    async callText(): Promise<string> {
      return ''
    },
    async testConnection(): Promise<{ success: boolean; error?: string }> {
      return state.testConnectionResult
    },
    updateConfig(config): void {
      state.configUpdates.push(config)
    }
  }
}

function freshState(): FakeProviderState {
  return {
    callVisionResult: '',
    visionCalls: [],
    testConnectionResult: { success: true },
    configUpdates: []
  }
}

const baseCtx: BrainContext = {
  appType: 'weixin',
  screenshot: 'data:image/png;base64,IMG',
  traceId: 'trace-abc'
}

async function collect(iter: AsyncIterable<BrainStream>): Promise<BrainStream[]> {
  const out: BrainStream[] = []
  for await (const s of iter) out.push(s)
  return out
}

describe('VlmBrain.decide', () => {
  it('emits a single skip when the screenshot is empty (no provider call)', async () => {
    const state = freshState()
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const events = await collect(brain.decide({ ...baseCtx, screenshot: '' }))

    expect(state.visionCalls).toHaveLength(0)
    expect(events).toEqual([{ decision: { type: 'skip', reason: 'empty screenshot' } }])
  })

  it('emits thinking + reply on a normal model response', async () => {
    const state = freshState()
    state.callVisionResult = '  好的，我等会儿过去  '
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const events = await collect(brain.decide(baseCtx))

    expect(events.length).toBe(2)
    expect(events[0]).toEqual({ thinking: '正在分析聊天内容...' })
    expect(events[1]).toEqual({ decision: { type: 'reply', text: '好的，我等会儿过去' } })
    expect(state.visionCalls).toHaveLength(1)
    expect(state.visionCalls[0].system).toBe(DEFAULT_REPLY_SYSTEM_PROMPT)
  })

  it('emits skip when the model returns the [SKIP] sentinel', async () => {
    const state = freshState()
    state.callVisionResult = '[SKIP]'
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const events = await collect(brain.decide(baseCtx))

    expect(events[events.length - 1]).toEqual({
      decision: { type: 'skip', reason: '[SKIP] sentinel' }
    })
  })

  it('emits skip when the model returns whitespace only', async () => {
    const state = freshState()
    state.callVisionResult = '   \n  '
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const events = await collect(brain.decide(baseCtx))

    expect(events[events.length - 1]).toEqual({
      decision: { type: 'skip', reason: 'empty response' }
    })
  })

  it('emits skip with the error message when the provider throws', async () => {
    const state = freshState()
    state.shouldThrow = new Error('upstream 502')
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const events = await collect(brain.decide(baseCtx))

    expect(events[events.length - 1]).toEqual({
      decision: { type: 'skip', reason: 'upstream 502' }
    })
  })

  it('uses a custom systemPrompt when supplied', async () => {
    const state = freshState()
    state.callVisionResult = 'fine'
    const brain = new VlmBrain({
      provider: makeFakeProvider(state),
      systemPrompt: 'CUSTOM PROMPT'
    })

    await collect(brain.decide(baseCtx))

    expect(state.visionCalls[0].system).toBe('CUSTOM PROMPT')
  })
})

describe('VlmBrain.testConnection', () => {
  it('delegates to the provider', async () => {
    const state = freshState()
    state.testConnectionResult = { success: false, error: 'no key' }
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    expect(await brain.testConnection()).toEqual({ success: false, error: 'no key' })
  })
})

describe('VlmBrain.updateConfig', () => {
  it('forwards apiKey/model/baseURL to provider, keeps systemPrompt local', async () => {
    const state = freshState()
    state.callVisionResult = 'ok'
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    brain.updateConfig({
      apiKey: 'new-key',
      model: 'new-model',
      baseURL: 'https://x.example.com',
      systemPrompt: 'NEW SYS'
    })

    // provider received exactly the LLM-protocol fields, not systemPrompt
    expect(state.configUpdates).toEqual([
      { apiKey: 'new-key', model: 'new-model', baseURL: 'https://x.example.com' }
    ])

    // next decide() picks up the new system prompt
    await collect(brain.decide(baseCtx))
    expect(state.visionCalls[0].system).toBe('NEW SYS')
  })

  it('does NOT call provider.updateConfig when only systemPrompt changes', () => {
    const state = freshState()
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    brain.updateConfig({ systemPrompt: 'only prompt' })

    expect(state.configUpdates).toHaveLength(0)
  })

  it('ignores empty systemPrompt patches (avoids accidentally clobbering with "")', async () => {
    const state = freshState()
    state.callVisionResult = 'ok'
    const brain = new VlmBrain({
      provider: makeFakeProvider(state),
      systemPrompt: 'INITIAL'
    })

    brain.updateConfig({ systemPrompt: '' })
    await collect(brain.decide(baseCtx))

    expect(state.visionCalls[0].system).toBe('INITIAL')
  })
})

describe('VlmBrain decide(): provider call shape', () => {
  it('passes the original screenshot string through unchanged', async () => {
    const state = freshState()
    state.callVisionResult = 'ok'
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    await collect(brain.decide({ ...baseCtx, screenshot: 'abc-123' }))

    expect(state.visionCalls[0].image).toBe('abc-123')
  })

  it('honours the test infrastructure: function-typed callVisionResult is awaited', async () => {
    const state = freshState()
    let calls = 0
    state.callVisionResult = (): string => {
      calls += 1
      return calls === 1 ? 'first' : 'second'
    }
    const brain = new VlmBrain({ provider: makeFakeProvider(state) })

    const a = await collect(brain.decide(baseCtx))
    const b = await collect(brain.decide(baseCtx))

    expect(a[a.length - 1]).toEqual({ decision: { type: 'reply', text: 'first' } })
    expect(b[b.length - 1]).toEqual({ decision: { type: 'reply', text: 'second' } })
    // sanity: vi.fn-style assertion on the fake
    expect(state.visionCalls).toHaveLength(2)
    vi.clearAllMocks()
  })
})
