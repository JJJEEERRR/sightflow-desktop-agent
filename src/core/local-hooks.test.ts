import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalHooks } from './local-hooks'
import {
  configureLogger,
  resetLoggerForTests,
  RingBufferSink,
  type LogRecord
} from './observability'

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

describe('LocalHooks lifecycle callbacks', () => {
  it('logs on engine start and engine stop', async () => {
    const hooks = new LocalHooks()
    await hooks.onEngineStart()
    await hooks.onEngineStop()

    const infos = recordsAt('info')
    expect(infos.some((r) => r.msg === 'Engine started')).toBe(true)
    expect(infos.some((r) => r.msg === 'Engine stopped')).toBe(true)
  })
})

describe('LocalHooks.executeActions', () => {
  it('yields {success:true} for each action in order', async () => {
    const hooks = new LocalHooks()
    const out: Array<{ type: string; success: boolean }> = []

    for await (const result of hooks.executeActions({
      actions: [
        { type: 'text', content: 'a' },
        { type: 'text', content: 'b' }
      ]
    })) {
      out.push({ type: result.action.type, success: result.success })
    }

    expect(out).toEqual([
      { type: 'text', success: true },
      { type: 'text', success: true }
    ])
  })

  it('handles an empty actions array (no records yielded, no throw)', async () => {
    const hooks = new LocalHooks()
    const out: unknown[] = []
    for await (const r of hooks.executeActions({ actions: [] })) out.push(r)
    expect(out).toEqual([])
  })
})

describe('LocalHooks.onActionComplete / onError', () => {
  it('logs onActionComplete with the action type and success flag', () => {
    const hooks = new LocalHooks()
    hooks.onActionComplete({ type: 'text', content: 'x' }, { success: true })

    const infos = recordsAt('info')
    const match = infos.find((r) => r.msg === 'Action completed')
    expect(match).toBeDefined()
    expect(match?.data).toMatchObject({ type: 'text', success: true })
  })

  it('logs onError with phase + Error.message at error level', () => {
    const hooks = new LocalHooks()
    hooks.onError(new Error('boom'), 'phase-x')

    const errors = recordsAt('error')
    const match = errors.find((r) => r.msg === 'Error in phase-x')
    expect(match).toBeDefined()
    // Logger pulls the Error into `err`, leaving `data` empty.
    expect(match?.err?.message).toBe('boom')
  })
})
