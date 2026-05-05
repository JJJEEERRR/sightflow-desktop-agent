import { describe, expect, it } from 'vitest'
import { newTraceId, newSpanId, withSpan } from './trace'
import type { TraceContext } from './types'

describe('newTraceId', () => {
  it('returns a 12-character hex string', () => {
    const id = newTraceId()
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('two consecutive calls produce different values', () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(a).not.toBe(b)
  })
})

describe('newSpanId', () => {
  it('returns an 8-character hex string', () => {
    const id = newSpanId()
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('two consecutive calls produce different values', () => {
    const a = newSpanId()
    const b = newSpanId()
    expect(a).not.toBe(b)
  })
})

describe('withSpan', () => {
  it('calls fn with a fresh TraceContext when parent is undefined', async () => {
    let received: TraceContext | undefined
    await withSpan(undefined, 'op', async (ctx) => {
      received = ctx
    })

    expect(received).toBeDefined()
    expect(received!.traceId).toMatch(/^[0-9a-f]{12}$/)
    expect(received!.spanId).toMatch(/^[0-9a-f]{8}$/)
    expect(received!.parentSpanId).toBeUndefined()
    expect(received!.startedAt).toBeGreaterThan(0)
  })

  it('propagates traceId from parent but creates a new spanId', async () => {
    const parentCtx: TraceContext = {
      traceId: 'aabbccddeeff',
      spanId: '11223344',
      startedAt: Date.now()
    }

    let received: TraceContext | undefined
    await withSpan(parentCtx, 'child', async (ctx) => {
      received = ctx
    })

    expect(received!.traceId).toBe('aabbccddeeff')
    expect(received!.spanId).not.toBe('11223344')
    expect(received!.parentSpanId).toBe('11223344')
  })

  it('returns the value the fn returns', async () => {
    const result = await withSpan(undefined, 'op', async (_ctx) => 42)
    expect(result).toBe(42)
  })

  it('re-throws if fn rejects', async () => {
    await expect(
      withSpan(undefined, 'op', async (_ctx) => {
        throw new Error('inner failure')
      })
    ).rejects.toThrow('inner failure')
  })

  it('sets startedAt to a recent timestamp', async () => {
    const before = Date.now()
    let received: TraceContext | undefined
    await withSpan(undefined, 'op', async (ctx) => {
      received = ctx
    })
    const after = Date.now()

    expect(received!.startedAt).toBeGreaterThanOrEqual(before)
    expect(received!.startedAt).toBeLessThanOrEqual(after)
  })
})
