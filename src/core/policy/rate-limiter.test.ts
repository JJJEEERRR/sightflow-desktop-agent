import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RateLimiter, type KvStorage } from './rate-limiter'
import { type RateLimiterConfig } from './config'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const HOURLY_KEY = 'policy.rateLimiter.hourly'
const PER_CONTACT_KEY = 'policy.rateLimiter.perContact'
const LAST_SEND_KEY = 'policy.rateLimiter.lastSendAt'

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

function defaultConfig(overrides: Partial<RateLimiterConfig> = {}): RateLimiterConfig {
  return {
    enabled: true,
    globalPerHour: 30,
    perContactPerDay: 20,
    minIntervalMs: 8_000,
    newContactCooldownMs: 60_000,
    ...overrides
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

describe('RateLimiter — initial state', () => {
  it('check() is allowed on a fresh limiter with empty storage', () => {
    const rl = new RateLimiter({
      config: defaultConfig(),
      storage: makeStorage(),
      now: () => 1_000_000
    })
    expect(rl.check()).toEqual({ allowed: true })
    expect(rl.check('contact-A')).toEqual({ allowed: true })
  })

  it('snapshot() reports zero usage and lastSendAt=0', () => {
    const rl = new RateLimiter({
      config: defaultConfig(),
      storage: makeStorage(),
      now: () => 5_000
    })
    const snap = rl.snapshot()
    expect(snap.hourly.used).toBe(0)
    expect(snap.hourly.max).toBe(30)
    expect(snap.lastSendAt).toBe(0)
    expect(snap.perContact).toEqual({})
  })
})

describe('RateLimiter — minInterval gate', () => {
  it('blocks a second send inside minIntervalMs and reports retryAfterMs', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 8_000 }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 3_000
    const r = rl.check('a')
    expect(r).toEqual({
      allowed: false,
      reason: 'minInterval',
      retryAfterMs: 5_000
    })
  })

  it('clears once enough time passes', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 8_000 }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 8_000
    expect(rl.check('a')).toEqual({ allowed: true })
  })

  it('minIntervalMs=0 disables the gate', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 0, newContactCooldownMs: 0 }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 1
    expect(rl.check('a')).toEqual({ allowed: true })
  })
})

describe('RateLimiter — globalPerHour gate', () => {
  it('blocks once cap reached and computes retryAfterMs from window end', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        globalPerHour: 3,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    // First recordSend opens the window at t=1_000_000.
    rl.recordSend('a')
    rl.recordSend('b')
    rl.recordSend('c')
    now += 60_000 // 1 minute later, still inside the hour window
    const r = rl.check('d')
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toBe('globalPerHour')
      expect(r.retryAfterMs).toBe(HOUR_MS - 60_000)
    }
  })

  it('resets after the hourly window rolls over', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        globalPerHour: 2,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    rl.recordSend('b')
    expect(rl.check('c').allowed).toBe(false)
    now += HOUR_MS
    expect(rl.check('c')).toEqual({ allowed: true })
  })

  it('globalPerHour=0 disables the gate entirely', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        globalPerHour: 0,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    for (let i = 0; i < 100; i++) {
      rl.recordSend(`c${i}`)
      now += 1
    }
    expect(rl.check('next')).toEqual({ allowed: true })
  })
})

describe('RateLimiter — perContactPerDay gate', () => {
  it('tracks counts independently per contact', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        perContactPerDay: 2,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 1
    rl.recordSend('a')
    now += 1
    const blockedA = rl.check('a')
    expect(blockedA.allowed).toBe(false)
    if (!blockedA.allowed) {
      expect(blockedA.reason).toBe('perContactPerDay')
    }
    // Different contact still allowed
    expect(rl.check('b')).toEqual({ allowed: true })
  })

  it('rolls over after 24h', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        perContactPerDay: 1,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    expect(rl.check('a').allowed).toBe(false)
    now += DAY_MS
    expect(rl.check('a')).toEqual({ allowed: true })
  })

  it('perContactPerDay=0 disables the gate', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        perContactPerDay: 0,
        globalPerHour: 0,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    for (let i = 0; i < 50; i++) {
      rl.recordSend('a')
      now += 1
    }
    expect(rl.check('a')).toEqual({ allowed: true })
  })
})

describe('RateLimiter — newContactCooldown gate', () => {
  it('blocks the second send if it is to a brand-new contact within cooldown', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        minIntervalMs: 0,
        newContactCooldownMs: 60_000
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 10_000 // less than 60s cooldown
    const r = rl.check('b') // brand new contact
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toBe('newContactCooldown')
      expect(r.retryAfterMs).toBe(50_000)
    }
  })

  it('does NOT block the very first send (lastSendAt === 0)', () => {
    const rl = new RateLimiter({
      config: defaultConfig({
        minIntervalMs: 0,
        newContactCooldownMs: 60_000
      }),
      storage: makeStorage(),
      now: () => 1_000_000
    })
    expect(rl.check('brand-new')).toEqual({ allowed: true })
  })

  it('does not apply once the contact has been recorded', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        minIntervalMs: 0,
        newContactCooldownMs: 60_000
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 1_000 // well within cooldown
    // 'a' is no longer "new", so newContactCooldown should not fire
    expect(rl.check('a')).toEqual({ allowed: true })
  })
})

describe('RateLimiter — enabled=false', () => {
  it('check() is always allowed and recordSend is a no-op', () => {
    const storage = makeStorage()
    const rl = new RateLimiter({
      config: defaultConfig({ enabled: false, globalPerHour: 1 }),
      storage,
      now: () => 1_000_000
    })
    rl.recordSend('a')
    rl.recordSend('a')
    rl.recordSend('a')
    expect(rl.check('a')).toEqual({ allowed: true })
    // recordSend was a no-op so nothing was persisted
    expect(storage._data.size).toBe(0)
  })

  it('preserves pre-existing persisted state when disabled', () => {
    const storage = makeStorage()
    storage.set(HOURLY_KEY, { count: 7, windowStartedAt: 500_000 })
    storage.set(LAST_SEND_KEY, 600_000)
    const rl = new RateLimiter({
      config: defaultConfig({ enabled: false }),
      storage,
      now: () => 700_000
    })
    rl.recordSend('a') // no-op
    expect(storage._data.get(HOURLY_KEY)).toEqual({
      count: 7,
      windowStartedAt: 500_000
    })
    expect(storage._data.get(LAST_SEND_KEY)).toBe(600_000)
    expect(rl.check('a')).toEqual({ allowed: true })
  })
})

describe('RateLimiter — persistence', () => {
  it('recordSend writes all three storage keys', () => {
    const storage = makeStorage()
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 0, newContactCooldownMs: 0 }),
      storage,
      now: () => 1_000_000
    })
    rl.recordSend('a')
    expect(storage._data.has(HOURLY_KEY)).toBe(true)
    expect(storage._data.has(PER_CONTACT_KEY)).toBe(true)
    expect(storage._data.has(LAST_SEND_KEY)).toBe(true)
    expect(storage._data.get(LAST_SEND_KEY)).toBe(1_000_000)
    expect(storage._data.get(HOURLY_KEY)).toEqual({
      count: 1,
      windowStartedAt: 1_000_000
    })
    expect(storage._data.get(PER_CONTACT_KEY)).toEqual({
      a: { count: 1, windowStartedAt: 1_000_000, firstSeenAt: 1_000_000 }
    })
  })

  it('constructor recovers state from storage', () => {
    const storage = makeStorage()
    storage.set(HOURLY_KEY, { count: 5, windowStartedAt: 1_000_000 })
    storage.set(PER_CONTACT_KEY, {
      a: { count: 3, windowStartedAt: 1_000_000, firstSeenAt: 900_000 }
    })
    storage.set(LAST_SEND_KEY, 1_500_000)
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 0, newContactCooldownMs: 0 }),
      storage,
      now: () => 1_600_000
    })
    const snap = rl.snapshot()
    expect(snap.hourly.used).toBe(5)
    expect(snap.lastSendAt).toBe(1_500_000)
    expect(snap.perContact.a?.used).toBe(3)
  })
})

describe('RateLimiter — snapshot', () => {
  it('reports correct used/max/resetAt for hourly and perContact', () => {
    let now = 2_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        globalPerHour: 5,
        perContactPerDay: 4,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    rl.recordSend('a')
    now += 100
    rl.recordSend('a')
    const snap = rl.snapshot()
    expect(snap.hourly.used).toBe(2)
    expect(snap.hourly.max).toBe(5)
    expect(snap.hourly.resetAt).toBe(2_000_000 + HOUR_MS)
    expect(snap.perContact.a).toEqual({
      used: 2,
      max: 4,
      resetAt: 2_000_000 + DAY_MS
    })
    expect(snap.lastSendAt).toBe(2_000_100)
  })

  it('check() does NOT mutate persisted state', () => {
    const storage = makeStorage()
    const rl = new RateLimiter({
      config: defaultConfig({ minIntervalMs: 0, newContactCooldownMs: 0 }),
      storage,
      now: () => 1_000_000
    })
    rl.check('a')
    rl.check('a')
    rl.check('a')
    expect(storage._data.size).toBe(0)
  })
})

describe('RateLimiter — updateConfig', () => {
  it('applies new limits to subsequent checks without resetting counts', () => {
    let now = 1_000_000
    const rl = new RateLimiter({
      config: defaultConfig({
        globalPerHour: 5,
        minIntervalMs: 0,
        newContactCooldownMs: 0
      }),
      storage: makeStorage(),
      now: () => now
    })
    for (let i = 0; i < 5; i++) {
      rl.recordSend(`c${i}`)
      now += 1
    }
    // At cap with old config
    expect(rl.check('next').allowed).toBe(false)

    // Loosen the cap — counts must NOT reset
    rl.updateConfig({ globalPerHour: 10 })
    expect(rl.snapshot().hourly.used).toBe(5)
    expect(rl.check('next')).toEqual({ allowed: true })

    // Tighten back below current usage — should block again
    rl.updateConfig({ globalPerHour: 3 })
    const r = rl.check('next')
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toBe('globalPerHour')
    }
  })
})
