import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureLogger, getLogger, resetLoggerForTests } from './logger'
import type { LogRecord, LogSink } from './types'

function makeCaptureSink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = []
  return {
    records,
    write(r: LogRecord): void {
      records.push(r)
    }
  }
}

beforeEach(() => {
  resetLoggerForTests()
})

afterEach(() => {
  resetLoggerForTests()
})

describe('LogRecord shape', () => {
  it('produces a valid ISO-8601 timestamp', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink], minLevel: 'trace' })
    const logger = getLogger('test')
    logger.info('hello')

    const r = sink.records[0]
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(new Date(r.ts).toISOString()).toBe(r.ts)
  })

  it('records level, phase, and msg correctly', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('engine').warn('something wrong')

    const r = sink.records[0]
    expect(r.level).toBe('warn')
    expect(r.phase).toBe('engine')
    expect(r.msg).toBe('something wrong')
  })

  it('includes traceId when provided', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('engine', 'abc123').info('with trace')

    expect(sink.records[0].traceId).toBe('abc123')
  })

  it('omits traceId when not provided', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('engine').info('no trace')

    expect(sink.records[0].traceId).toBeUndefined()
  })

  it('includes data when provided', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('engine').info('msg', { count: 5 })

    expect(sink.records[0].data).toEqual({ count: 5 })
  })
})

describe('minLevel filtering', () => {
  it('suppresses trace when minLevel is info', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'prod', sinks: [sink], minLevel: 'info' })
    getLogger('x').trace('ignored')
    expect(sink.records).toHaveLength(0)
  })

  it('suppresses debug when minLevel is info', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'prod', sinks: [sink], minLevel: 'info' })
    getLogger('x').debug('ignored')
    expect(sink.records).toHaveLength(0)
  })

  it('allows info when minLevel is info', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'prod', sinks: [sink], minLevel: 'info' })
    getLogger('x').info('allowed')
    expect(sink.records).toHaveLength(1)
  })

  it('allows trace when minLevel is trace', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink], minLevel: 'trace' })
    getLogger('x').trace('allowed')
    expect(sink.records).toHaveLength(1)
  })

  it('defaults to debug in dev env when minLevel not specified', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('x').debug('visible')
    getLogger('x').trace('suppressed')
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].msg).toBe('visible')
  })

  it('defaults to info in prod env when minLevel not specified', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'prod', sinks: [sink] })
    getLogger('x').debug('suppressed')
    getLogger('x').info('visible')
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0].msg).toBe('visible')
  })
})

describe('child logger', () => {
  it('produces phase="engine.tick" from parent "engine" + child "tick"', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    const parent = getLogger('engine')
    const child = parent.child('tick', 'abc123')
    child.info('ticked')

    expect(sink.records[0].phase).toBe('engine.tick')
    expect(sink.records[0].traceId).toBe('abc123')
  })

  it('inherits parent traceId when not overridden', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    const parent = getLogger('engine', 'parent-trace')
    const child = parent.child('tick')
    child.info('msg')

    expect(sink.records[0].traceId).toBe('parent-trace')
  })
})

describe('error() method', () => {
  it('populates err field when given an Error', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    const err = new Error('boom')
    getLogger('x').error('failed', err)

    const r = sink.records[0]
    expect(r.err?.name).toBe('Error')
    expect(r.err?.message).toBe('boom')
    expect(r.err?.stack).toBeDefined()
    expect(r.data).toBeUndefined()
  })

  it('populates data when given a plain object', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('x').error('oops', { key: 'v' })

    const r = sink.records[0]
    expect(r.data).toEqual({ key: 'v' })
    expect(r.err).toBeUndefined()
  })

  it('splits { err: Error, ...rest } into both err and data fields', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    const err = new Error('underlying')
    getLogger('x').error('context error', { err, ctx: 1 })

    const r = sink.records[0]
    expect(r.err?.message).toBe('underlying')
    expect(r.data).toEqual({ ctx: 1 })
  })

  it('works with no second argument', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('x').error('simple error')

    const r = sink.records[0]
    expect(r.level).toBe('error')
    expect(r.err).toBeUndefined()
    expect(r.data).toBeUndefined()
  })
})

describe('redaction', () => {
  it('redacts sensitive data fields before writing to sink', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    getLogger('x').info('msg', { apiKey: 'my-secret', name: 'John' })

    const r = sink.records[0]
    expect(r.data?.apiKey).toBe('[REDACTED]')
    expect(r.data?.name).toBe('John')
  })
})

describe('multiple sinks', () => {
  it('fans out each record to all configured sinks', () => {
    const sink1 = makeCaptureSink()
    const sink2 = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink1, sink2] })
    getLogger('x').info('broadcast')

    expect(sink1.records).toHaveLength(1)
    expect(sink2.records).toHaveLength(1)
    expect(sink1.records[0].msg).toBe('broadcast')
    expect(sink2.records[0].msg).toBe('broadcast')
  })
})

describe('resilience', () => {
  it('does not crash when a sink throws', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const badSink: LogSink = {
      write(): void {
        throw new Error('sink exploded')
      }
    }
    configureLogger({ env: 'dev', sinks: [badSink] })

    expect(() => getLogger('x').info('msg')).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('resetLoggerForTests', () => {
  it('clears sinks so subsequent writes go nowhere', () => {
    const sink = makeCaptureSink()
    configureLogger({ env: 'dev', sinks: [sink] })
    resetLoggerForTests()
    getLogger('x').info('after reset')
    expect(sink.records).toHaveLength(0)
  })
})
