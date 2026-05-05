import { randomBytes } from 'crypto'
import type { TraceContext } from './types'

export function newTraceId(): string {
  return randomBytes(6).toString('hex')
}

export function newSpanId(): string {
  return randomBytes(4).toString('hex')
}

export async function withSpan<T>(
  parent: TraceContext | undefined,
  _name: string,
  fn: (ctx: TraceContext) => Promise<T>
): Promise<T> {
  const ctx: TraceContext = {
    traceId: parent?.traceId ?? newTraceId(),
    parentSpanId: parent?.spanId,
    spanId: newSpanId(),
    startedAt: Date.now()
  }
  return fn(ctx)
}
