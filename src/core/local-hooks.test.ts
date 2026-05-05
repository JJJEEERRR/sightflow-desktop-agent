import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalHooks } from './local-hooks'
import type { ReplyAction } from './hooks'
import {
  configureLogger,
  resetLoggerForTests,
  RingBufferSink,
  type LogRecord
} from './observability'

// Mock the AIClient module — every LocalHooks instance constructs one, and we
// want fully deterministic behaviour without touching the network.
vi.mock('./ai-client', () => {
  return {
    AIClient: class {
      apiKey: string
      lastReplyResult: string | null = 'mock reply'
      shouldThrow = false
      testConnectionResult: { success: boolean; error?: string } = { success: true }
      updateConfigCalls: Array<unknown> = []
      constructor(config: { apiKey: string }) {
        this.apiKey = config.apiKey
      }
      async testConnection(): Promise<{ success: boolean; error?: string }> {
        return this.testConnectionResult
      }
      async getReply(_screenshot: string): Promise<string | null> {
        if (this.shouldThrow) throw new Error('boom')
        return this.lastReplyResult
      }
      updateConfig(c: unknown): void {
        this.updateConfigCalls.push(c)
      }
    }
  }
})

// LocalHooks now writes through the structured logger. Capture every record
// in an in-memory ring buffer so tests can assert on the level/phase/msg.
let logBuffer: RingBufferSink

function recordsAt(level: LogRecord['level']): LogRecord[] {
  return logBuffer.getAll().filter((r) => r.level === level)
}

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 100 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'trace' })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetLoggerForTests()
})

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('LocalHooks.onEngineStart', () => {
  it('calls testConnection and does not throw on failure', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    const ai = (hooks as unknown as { aiClient: { testConnectionResult: unknown } }).aiClient
    ai.testConnectionResult = { success: false, error: 'no key' }
    await expect(hooks.onEngineStart()).resolves.toBeUndefined()
    expect(recordsAt('error')).not.toHaveLength(0)
  })

  it('logs OK when testConnection succeeds', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    await hooks.onEngineStart()
    expect(recordsAt('info').some((r) => r.msg.includes('AI API 连接正常'))).toBe(true)
  })
})

describe('LocalHooks.getReply', () => {
  it('yields a thinking action followed by a text action when AI returns text', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    const actions = await collect(hooks.getReply({ screenshot: 'data:image/png;base64,X' }))

    expect(actions[0].type).toBe('thinking')
    const textAction = actions.find((a) => a.type === 'text') as
      | Extract<ReplyAction, { type: 'text' }>
      | undefined
    expect(textAction?.content).toBe('mock reply')
  })

  it('yields a single skip action when there is no screenshot', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    const actions = await collect(hooks.getReply({ screenshot: '' }))
    expect(actions).toEqual([{ type: 'skip' }])
  })

  it('yields skip when AIClient returns null (model said [SKIP])', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    const ai = (hooks as unknown as { aiClient: { lastReplyResult: string | null } }).aiClient
    ai.lastReplyResult = null

    const actions = await collect(hooks.getReply({ screenshot: 'X' }))
    // First yields 'thinking', then 'skip'
    expect(actions[actions.length - 1]).toEqual({ type: 'skip' })
  })

  it('yields skip and logs an error when AIClient throws', async () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    const ai = (hooks as unknown as { aiClient: { shouldThrow: boolean } }).aiClient
    ai.shouldThrow = true

    const actions = await collect(hooks.getReply({ screenshot: 'X' }))
    expect(actions[actions.length - 1]).toEqual({ type: 'skip' })
    expect(recordsAt('error')).not.toHaveLength(0)
  })
})

describe('LocalHooks.updateAIConfig', () => {
  it('forwards the config to AIClient.updateConfig', () => {
    const hooks = new LocalHooks({ ai: { apiKey: 'k' } })
    hooks.updateAIConfig({ apiKey: 'k2', model: 'foo' })
    const ai = (hooks as unknown as { aiClient: { updateConfigCalls: Array<unknown> } }).aiClient
    expect(ai.updateConfigCalls).toEqual([{ apiKey: 'k2', model: 'foo' }])
  })
})
