import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AntiDetectionPolicy } from './policy'
import type { KvStorage } from './rate-limiter'
import type { HumanizerClock } from './humanizer'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

function makeStorage(): KvStorage & { _data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    _data: data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined
    },
    set(key: string, value: unknown): void {
      data.set(key, value)
    }
  }
}

class FakeClock implements HumanizerClock {
  slept: number[] = []
  randomValue = 0.5
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms)
  }
  random(): number {
    return this.randomValue
  }
  totalSleptMs(): number {
    return this.slept.reduce((a, b) => a + b, 0)
  }
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
})

describe('AntiDetectionPolicy — defaults & schema', () => {
  it('parses {} into a fully-defaulted config', () => {
    const p = new AntiDetectionPolicy({ storage: makeStorage() })
    const cfg = p.getConfig()
    expect(cfg.humanizer.enabled).toBe(true)
    expect(cfg.rateLimiter.globalPerHour).toBe(30)
    expect(cfg.schedule.enabled).toBe(false)
    expect(cfg.circuitBreaker.consecutiveAiFailures).toBe(5)
  })

  it('snapshot exposes all four sub-modules', () => {
    const p = new AntiDetectionPolicy({ storage: makeStorage() })
    const s = p.snapshot()
    expect(s.config).toBeDefined()
    expect(s.rateLimiter).toBeDefined()
    expect(s.schedule).toBeDefined()
    expect(s.circuitBreaker).toBeDefined()
  })
})

describe('AntiDetectionPolicy — beforeReply: circuit breaker', () => {
  it('blocks with proceed:false + pause directive once breaker has tripped', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => 1000,
      config: {
        circuitBreaker: { consecutiveAiFailures: 1 } as never
      }
    })
    p.observe({ type: 'aiFailure' })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(false)
    if (!r.proceed) {
      expect(r.pause).toBeDefined()
      expect(r.pause?.reason).toBe('breaker')
      expect(r.reason).toMatch(/breaker:consecutiveAiFailures/)
      expect(r.waitMs).toBe(0)
    }
  })

  it('does NOT call humanizer delays when blocked by breaker', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => 1000,
      config: { circuitBreaker: { consecutiveAiFailures: 1 } as never }
    })
    p.observe({ type: 'aiFailure' })
    await p.beforeReply()
    expect(clock.slept.length).toBe(0)
  })

  it('resetBreaker un-trips and lets subsequent ticks proceed', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => 1000,
      config: { circuitBreaker: { consecutiveAiFailures: 1 } as never }
    })
    p.observe({ type: 'aiFailure' })
    expect((await p.beforeReply()).proceed).toBe(false)
    p.resetBreaker()
    const r = await p.beforeReply()
    expect(r.proceed).toBe(true)
  })
})

describe('AntiDetectionPolicy — beforeReply: schedule', () => {
  it('returns proceed:false with waitMs and NO pause when schedule asleep (no windows)', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: { schedule: { enabled: true, windows: {} } as never }
    })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(false)
    if (!r.proceed) {
      expect(r.pause).toBeUndefined()
      expect(r.reason).toMatch(/schedule:outOfWindow/)
      expect(r.waitMs).toBeGreaterThan(0)
    }
  })

  it('proceeds when schedule disabled (always awake)', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: { schedule: { enabled: false } as never }
    })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(true)
  })
})

describe('AntiDetectionPolicy — beforeReply: rate limiter', () => {
  it('returns proceed:false with retryAfterMs when minInterval gates', async () => {
    const clock = new FakeClock()
    let now = 1_000_000
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => now,
      config: { rateLimiter: { minIntervalMs: 5000 } as never }
    })
    // First send.
    await p.afterAction({ type: 'reply', text: 'hi' }, { success: true })
    // Advance only 1s — under the 5s min-interval.
    now += 1000
    const r = await p.beforeReply()
    expect(r.proceed).toBe(false)
    if (!r.proceed) {
      expect(r.reason).toMatch(/rateLimit:minInterval/)
      expect(r.waitMs).toBeGreaterThanOrEqual(3000)
      expect(r.waitMs).toBeLessThanOrEqual(5000)
      expect(r.pause).toBeUndefined()
    }
  })

  it('proceeds once min-interval has elapsed', async () => {
    const clock = new FakeClock()
    let now = 1_000_000
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => now,
      config: { rateLimiter: { minIntervalMs: 5000 } as never }
    })
    await p.afterAction({ type: 'reply', text: 'hi' }, { success: true })
    now += 6000
    const r = await p.beforeReply()
    expect(r.proceed).toBe(true)
  })
})

describe('AntiDetectionPolicy — beforeReply: pacing delays', () => {
  it('awaits readDelay when proceed:true', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock
    })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(true)
    // readDelay always sleeps when humanizer enabled.
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  it('beforeReply skips all delays when humanizer disabled', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: {
        humanizer: { enabled: false } as never,
        schedule: { enabled: false } as never
      }
    })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(true)
    expect(clock.slept.length).toBe(0)
  })
})

describe('AntiDetectionPolicy — beforeAction / afterAction', () => {
  it('beforeAction(click) returns jittered coords', async () => {
    const clock = new FakeClock()
    clock.randomValue = 1
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: { humanizer: { clickJitterPx: 3 } as never }
    })
    const r = await p.beforeAction({ type: 'click', coords: [100, 200] })
    expect(r.jitteredCoords).toBeDefined()
    if (r.jitteredCoords) {
      const [x, y] = r.jitteredCoords
      expect(x).toBeGreaterThanOrEqual(97)
      expect(x).toBeLessThanOrEqual(103)
      expect(y).toBeGreaterThanOrEqual(197)
      expect(y).toBeLessThanOrEqual(203)
    }
  })

  it('beforeAction(reply) does NOT return jitteredCoords', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock
    })
    const r = await p.beforeAction({ type: 'reply', text: 'hi' })
    expect(r.jitteredCoords).toBeUndefined()
  })

  it('afterAction(reply, success) records the send into rate-limiter', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => 1000
    })
    await p.afterAction({ type: 'reply', text: 'hi' }, { success: true })
    expect(p.snapshot().rateLimiter.lastSendAt).toBe(1000)
    expect(p.snapshot().rateLimiter.hourly.used).toBe(1)
  })

  it('afterAction(reply, success) feeds replyText into the breaker', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: { circuitBreaker: { duplicateReplyCount: 2 } as never }
    })
    await p.afterAction({ type: 'reply', text: 'same' }, { success: true })
    await p.afterAction({ type: 'reply', text: 'same' }, { success: true })
    const r = await p.beforeReply()
    expect(r.proceed).toBe(false)
    if (!r.proceed) expect(r.reason).toMatch(/breaker:duplicateReply/)
  })

  it('afterAction(reply, success: false) emits rpaFailure into the breaker', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      config: { circuitBreaker: { consecutiveRpaFailures: 2 } as never }
    })
    await p.afterAction({ type: 'reply', text: 'a' }, { success: false })
    await p.afterAction({ type: 'reply', text: 'b' }, { success: false })
    expect(p.snapshot().circuitBreaker.state.tripped).toBe(true)
  })

  it('afterAction(reply, success: false) does NOT record into rate-limiter', async () => {
    const clock = new FakeClock()
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      humanizerClock: clock,
      now: () => 1000
    })
    await p.afterAction({ type: 'reply', text: 'hi' }, { success: false })
    expect(p.snapshot().rateLimiter.lastSendAt).toBe(0)
    expect(p.snapshot().rateLimiter.hourly.used).toBe(0)
  })
})

describe('AntiDetectionPolicy — observe', () => {
  it('forwards aiFailure to the breaker', async () => {
    const p = new AntiDetectionPolicy({
      storage: makeStorage(),
      config: { circuitBreaker: { consecutiveAiFailures: 1 } as never }
    })
    p.observe({ type: 'aiFailure' })
    expect(p.snapshot().circuitBreaker.state.tripped).toBe(true)
  })

  it('forwards screenText with a banned keyword', () => {
    const p = new AntiDetectionPolicy({ storage: makeStorage() })
    p.observe({ type: 'screenText', text: '弹窗：账号异常，请处理' })
    expect(p.snapshot().circuitBreaker.state.tripped).toBe(true)
  })
})

describe('AntiDetectionPolicy — updateConfig', () => {
  it('shallow-merges into all sub-modules and validates with zod', () => {
    const p = new AntiDetectionPolicy({ storage: makeStorage() })
    p.updateConfig({
      rateLimiter: { ...p.getConfig().rateLimiter, minIntervalMs: 99 }
    })
    expect(p.getConfig().rateLimiter.minIntervalMs).toBe(99)
  })

  it('rejects invalid patches', () => {
    const p = new AntiDetectionPolicy({ storage: makeStorage() })
    expect(() => {
      p.updateConfig({
        rateLimiter: { ...p.getConfig().rateLimiter, minIntervalMs: -5 }
      })
    }).toThrow()
  })
})
