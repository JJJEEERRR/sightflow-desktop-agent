import { describe, expect, it, beforeEach } from 'vitest'
import { Metrics, metrics as globalMetrics } from './metrics'

describe('Metrics.counter', () => {
  it('increments by 1 and shows in snapshot', () => {
    const m = new Metrics()
    m.counter('a')
    expect(m.snapshot().counters['a']).toBe(1)
  })

  it('increments multiple times', () => {
    const m = new Metrics()
    m.counter('a')
    m.counter('a')
    m.counter('a')
    expect(m.snapshot().counters['a']).toBe(3)
  })

  it('increments by custom delta', () => {
    const m = new Metrics()
    m.counter('requests', undefined, 5)
    expect(m.snapshot().counters['requests']).toBe(5)
  })

  it('generates separate keys for different labels', () => {
    const m = new Metrics()
    m.counter('http', { method: 'GET' })
    m.counter('http', { method: 'POST' })
    const snap = m.snapshot()
    expect(snap.counters['http{method=GET}']).toBe(1)
    expect(snap.counters['http{method=POST}']).toBe(1)
  })

  it('label key is sorted (order-independent)', () => {
    const m = new Metrics()
    m.counter('req', { b: '2', a: '1' })
    m.counter('req', { a: '1', b: '2' })
    const snap = m.snapshot()
    expect(snap.counters['req{a=1,b=2}']).toBe(2)
  })
})

describe('Metrics.histogram', () => {
  it('computes count, sum, min, max correctly', () => {
    const m = new Metrics()
    m.histogram('latency', 10)
    m.histogram('latency', 20)
    m.histogram('latency', 30)
    const snap = m.snapshot().histograms['latency']
    expect(snap.count).toBe(3)
    expect(snap.sum).toBe(60)
    expect(snap.min).toBe(10)
    expect(snap.max).toBe(30)
  })

  it('computes p50 and p95 from 1..100', () => {
    const m = new Metrics()
    for (let i = 1; i <= 100; i++) {
      m.histogram('val', i)
    }
    const snap = m.snapshot().histograms['val']
    expect(snap.p50).toBeCloseTo(50.5, 0)
    expect(snap.p95).toBeCloseTo(95.5, 0)
  })

  it('ring buffer: only last 1024 values retained after 2000 inserts', () => {
    const m = new Metrics()
    for (let i = 1; i <= 2000; i++) {
      m.histogram('big', i)
    }
    const snap = m.snapshot().histograms['big']
    expect(snap.count).toBe(2000)
    // Only last 1024 kept: min should be 2000-1024+1 = 977
    expect(snap.min).toBe(977)
    expect(snap.max).toBe(2000)
  })

  it('histogram with labels generates separate keys', () => {
    const m = new Metrics()
    m.histogram('rt', 100, { region: 'us' })
    m.histogram('rt', 200, { region: 'eu' })
    const snap = m.snapshot()
    expect(snap.histograms['rt{region=us}']).toBeDefined()
    expect(snap.histograms['rt{region=eu}']).toBeDefined()
  })
})

describe('Metrics.reset', () => {
  it('clears all counters and histograms', () => {
    const m = new Metrics()
    m.counter('x')
    m.histogram('y', 1)
    m.reset()
    const snap = m.snapshot()
    expect(Object.keys(snap.counters)).toHaveLength(0)
    expect(Object.keys(snap.histograms)).toHaveLength(0)
  })
})

describe('Metrics singleton independence', () => {
  beforeEach(() => {
    globalMetrics.reset()
  })

  it('new Metrics() instance does not share state with another', () => {
    const a = new Metrics()
    const b = new Metrics()
    a.counter('test')
    expect(b.snapshot().counters['test']).toBeUndefined()
  })

  it('global metrics singleton exists and is independent of new instances', () => {
    globalMetrics.counter('global_event')
    const fresh = new Metrics()
    fresh.counter('local_event')
    expect(globalMetrics.snapshot().counters['global_event']).toBe(1)
    expect(globalMetrics.snapshot().counters['local_event']).toBeUndefined()
    expect(fresh.snapshot().counters['local_event']).toBe(1)
  })
})

describe('MetricsSnapshot shape', () => {
  it('takenAt is a valid ISO-8601 string', () => {
    const m = new Metrics()
    const snap = m.snapshot()
    expect(snap.takenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('snapshot counters and histograms are empty objects when nothing recorded', () => {
    const m = new Metrics()
    const snap = m.snapshot()
    expect(snap.counters).toEqual({})
    expect(snap.histograms).toEqual({})
  })
})
