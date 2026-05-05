import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CircuitBreaker } from './circuit-breaker'
import { defaultAntiDetectionConfig, type CircuitBreakerConfig } from './config'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

function makeClock(): { now: () => number; advance(ms: number): void; set(t: number): void } {
  let t = 0
  return {
    now: (): number => t,
    advance(ms: number): void {
      t += ms
    },
    set(v: number): void {
      t = v
    }
  }
}

function makeConfig(patch: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig {
  return { ...defaultAntiDetectionConfig().circuitBreaker, ...patch }
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
})

describe('CircuitBreaker — initial state', () => {
  it('starts not tripped', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('snapshot reflects fresh state', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    const s = cb.snapshot()
    expect(s.consecutiveAiFailures).toBe(0)
    expect(s.consecutiveRpaFailures).toBe(0)
    expect(s.recentReplyText).toEqual([])
    expect(s.lastScreenshotHash).toBeNull()
    expect(s.state.tripped).toBe(false)
  })
})

describe('CircuitBreaker — AI failures', () => {
  it('does not trip below the threshold (default 5)', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    for (let i = 0; i < 4; i++) cb.observe({ type: 'aiFailure' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('trips on the 5th consecutive AI failure', () => {
    const clock = makeClock()
    clock.set(1000)
    const cb = new CircuitBreaker({ config: makeConfig(), now: clock.now })
    for (let i = 0; i < 5; i++) cb.observe({ type: 'aiFailure' })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) {
      expect(s.reason).toBe('consecutiveAiFailures')
      expect(s.detail).toMatch(/5 consecutive AI failures/)
      expect(s.at).toBe(1000)
    }
  })

  it('aiSuccess resets the consecutive counter', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'aiFailure' })
    cb.observe({ type: 'aiFailure' })
    cb.observe({ type: 'aiSuccess' })
    cb.observe({ type: 'aiFailure' })
    cb.observe({ type: 'aiFailure' })
    cb.observe({ type: 'aiFailure' })
    cb.observe({ type: 'aiFailure' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('logs a warn record when tripping', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    for (let i = 0; i < 5; i++) cb.observe({ type: 'aiFailure' })
    const warns = logBuffer
      .getAll()
      .filter((r) => r.level === 'warn' && r.phase === 'policy.circuit-breaker')
    expect(warns.length).toBe(1)
    expect(warns[0].msg).toMatch(/tripped/i)
  })
})

describe('CircuitBreaker — RPA failures', () => {
  it('trips on the 3rd consecutive RPA failure (default)', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'rpaFailure' })
    cb.observe({ type: 'rpaFailure' })
    expect(cb.state()).toEqual({ tripped: false })
    cb.observe({ type: 'rpaFailure' })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) expect(s.reason).toBe('consecutiveRpaFailures')
  })

  it('rpaSuccess resets the counter', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'rpaFailure' })
    cb.observe({ type: 'rpaFailure' })
    cb.observe({ type: 'rpaSuccess' })
    cb.observe({ type: 'rpaFailure' })
    cb.observe({ type: 'rpaFailure' })
    expect(cb.state()).toEqual({ tripped: false })
  })
})

describe('CircuitBreaker — sticky semantics & updateConfig', () => {
  it('once tripped, further failures do not change state', () => {
    const clock = makeClock()
    clock.set(1000)
    const cb = new CircuitBreaker({ config: makeConfig(), now: clock.now })
    for (let i = 0; i < 5; i++) cb.observe({ type: 'aiFailure' })
    const before = cb.state()
    expect(before.tripped).toBe(true)
    if (before.tripped) {
      const at = before.at
      clock.set(2000)
      cb.observe({ type: 'aiFailure' })
      cb.observe({ type: 'aiFailure' })
      const after = cb.state()
      expect(after.tripped).toBe(true)
      if (after.tripped) {
        expect(after.at).toBe(at) // sticky timestamp
        expect(after.reason).toBe(before.reason)
      }
    }
  })

  it('counters keep updating in snapshot even when tripped', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    for (let i = 0; i < 7; i++) cb.observe({ type: 'aiFailure' })
    expect(cb.snapshot().consecutiveAiFailures).toBe(7)
  })

  it('updateConfig({ consecutiveAiFailures: 2 }) trips on the 2nd failure observed AFTER the patch', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'aiFailure' }) // 1 (under default threshold of 5)
    cb.observe({ type: 'aiFailure' }) // 2
    expect(cb.state()).toEqual({ tripped: false })

    cb.updateConfig({ consecutiveAiFailures: 2 })
    // counter is already at 2 — the spec says we do NOT trip retroactively
    expect(cb.state()).toEqual({ tripped: false })

    cb.observe({ type: 'aiFailure' }) // 3, exceeds new threshold
    expect(cb.state().tripped).toBe(true)
  })
})

describe('CircuitBreaker — duplicateReply', () => {
  it('trips when N identical replies are observed in a row (default 3)', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'replyText', text: '好的' })
    cb.observe({ type: 'replyText', text: '好的' })
    expect(cb.state()).toEqual({ tripped: false })
    cb.observe({ type: 'replyText', text: '好的' })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) {
      expect(s.reason).toBe('duplicateReply')
      expect(s.detail).toMatch(/好的/)
    }
  })

  it('mixed values do not trip', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'replyText', text: 'a' })
    cb.observe({ type: 'replyText', text: 'b' })
    cb.observe({ type: 'replyText', text: 'a' })
    cb.observe({ type: 'replyText', text: 'b' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('caps recentReplyText at duplicateReplyCount * 2', () => {
    const cb = new CircuitBreaker({
      config: makeConfig({ duplicateReplyCount: 3 }),
      now: makeClock().now
    })
    for (let i = 0; i < 20; i++) cb.observe({ type: 'replyText', text: `t${i}` })
    expect(cb.snapshot().recentReplyText.length).toBeLessThanOrEqual(6)
  })

  it('truncates very long repeated text in detail', () => {
    const long = 'x'.repeat(200)
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'replyText', text: long })
    cb.observe({ type: 'replyText', text: long })
    cb.observe({ type: 'replyText', text: long })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) {
      expect(s.detail.length).toBeLessThan(long.length)
      expect(s.detail).toMatch(/…/)
    }
  })
})

describe('CircuitBreaker — screenshotFreeze', () => {
  const freezeMs = 5000
  const cfg = (): CircuitBreakerConfig => makeConfig({ screenshotFreezeMs: freezeMs })

  it('first observation never trips and seeds the watermark', () => {
    const clock = makeClock()
    clock.set(1000)
    const cb = new CircuitBreaker({ config: cfg(), now: clock.now })
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    expect(cb.state()).toEqual({ tripped: false })
    const s = cb.snapshot()
    expect(s.lastScreenshotHash).toBe('h1')
    expect(s.lastScreenshotChangeAt).toBe(1000)
  })

  it('different hash before timeout resets the timer', () => {
    const clock = makeClock()
    clock.set(0)
    const cb = new CircuitBreaker({ config: cfg(), now: clock.now })
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    clock.advance(4000)
    cb.observe({ type: 'screenshotHash', hash: 'h2' })
    clock.advance(4000)
    cb.observe({ type: 'screenshotHash', hash: 'h2' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('same hash for >= screenshotFreezeMs trips on the next observation that completes the timeout', () => {
    const clock = makeClock()
    clock.set(0)
    const cb = new CircuitBreaker({ config: cfg(), now: clock.now })
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    clock.advance(freezeMs)
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) expect(s.reason).toBe('screenshotFreeze')
  })

  it('does not trip while still within the timeout', () => {
    const clock = makeClock()
    clock.set(0)
    const cb = new CircuitBreaker({ config: cfg(), now: clock.now })
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    clock.advance(freezeMs - 1)
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    expect(cb.state()).toEqual({ tripped: false })
  })
})

describe('CircuitBreaker — bannedKeyword', () => {
  it('trips when text contains a banned keyword', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'screenText', text: '提示：账号异常，请登录' })
    const s = cb.state()
    expect(s.tripped).toBe(true)
    if (s.tripped) {
      expect(s.reason).toBe('bannedKeyword')
      expect(s.detail).toMatch(/账号异常/)
    }
  })

  it('does not trip without any banned keyword', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    cb.observe({ type: 'screenText', text: '一切正常' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('empty bannedKeywords list disables the check', () => {
    const cb = new CircuitBreaker({
      config: makeConfig({ bannedKeywords: [] }),
      now: makeClock().now
    })
    cb.observe({ type: 'screenText', text: '账号异常' })
    expect(cb.state()).toEqual({ tripped: false })
  })

  it('respects custom keyword list', () => {
    const cb = new CircuitBreaker({
      config: makeConfig({ bannedKeywords: ['custom-marker'] }),
      now: makeClock().now
    })
    cb.observe({ type: 'screenText', text: 'foo custom-marker bar' })
    expect(cb.state().tripped).toBe(true)
  })
})

describe('CircuitBreaker — reset()', () => {
  it('un-trips and zeroes consecutive counters; subsequent failures must reach threshold again', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    for (let i = 0; i < 5; i++) cb.observe({ type: 'aiFailure' })
    expect(cb.state().tripped).toBe(true)

    cb.reset()
    expect(cb.state()).toEqual({ tripped: false })
    expect(cb.snapshot().consecutiveAiFailures).toBe(0)
    expect(cb.snapshot().recentReplyText).toEqual([])

    for (let i = 0; i < 4; i++) cb.observe({ type: 'aiFailure' })
    expect(cb.state()).toEqual({ tripped: false })
    cb.observe({ type: 'aiFailure' })
    expect(cb.state().tripped).toBe(true)
  })

  it('reset() preserves lastScreenshotHash so a brief reset does not re-arm freeze on the next observation', () => {
    const clock = makeClock()
    clock.set(0)
    const cb = new CircuitBreaker({
      config: makeConfig({ screenshotFreezeMs: 1000 }),
      now: clock.now
    })
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    clock.advance(1000)
    cb.observe({ type: 'screenshotHash', hash: 'h1' })
    expect(cb.state().tripped).toBe(true)

    cb.reset()
    const s = cb.snapshot()
    expect(s.lastScreenshotHash).toBe('h1')
    expect(s.lastScreenshotChangeAt).toBe(0)
  })

  it('logs an info record on reset', () => {
    const cb = new CircuitBreaker({ config: makeConfig(), now: makeClock().now })
    for (let i = 0; i < 5; i++) cb.observe({ type: 'aiFailure' })
    cb.reset()
    const infos = logBuffer
      .getAll()
      .filter((r) => r.level === 'info' && r.phase === 'policy.circuit-breaker')
    expect(infos.length).toBe(1)
    expect(infos[0].msg).toMatch(/reset/i)
  })
})

describe('CircuitBreaker — enabled: false', () => {
  it('ignores all observe() calls', () => {
    const cb = new CircuitBreaker({
      config: makeConfig({ enabled: false }),
      now: makeClock().now
    })
    for (let i = 0; i < 100; i++) {
      cb.observe({ type: 'aiFailure' })
      cb.observe({ type: 'rpaFailure' })
      cb.observe({ type: 'replyText', text: 'same' })
      cb.observe({ type: 'screenText', text: '账号异常' })
    }
    expect(cb.state()).toEqual({ tripped: false })
    const s = cb.snapshot()
    expect(s.consecutiveAiFailures).toBe(0)
    expect(s.consecutiveRpaFailures).toBe(0)
  })

  it('reset() and snapshot() still work when disabled', () => {
    const cb = new CircuitBreaker({
      config: makeConfig({ enabled: false }),
      now: makeClock().now
    })
    expect(() => cb.reset()).not.toThrow()
    const s = cb.snapshot()
    expect(s.state.tripped).toBe(false)
  })
})
