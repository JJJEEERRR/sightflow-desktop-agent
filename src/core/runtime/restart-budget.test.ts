import { describe, expect, it } from 'vitest'
import { RestartBudget } from './restart-budget'

describe('RestartBudget — initial state', () => {
  it('starts with used() === 0', () => {
    const b = new RestartBudget({ max: 5, windowMs: 60_000 })
    expect(b.used()).toBe(0)
  })

  it('windowEndsAt() is approximately now+windowMs when empty', () => {
    const t = 1_000_000
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    const endsAt = new Date(b.windowEndsAt()).getTime()
    expect(endsAt).toBe(t + 60_000)
  })
})

describe('RestartBudget — recordAndCheck within window', () => {
  it('allows max=5 consecutive calls and all return true', () => {
    let t = 0
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    const results: boolean[] = []
    for (let i = 0; i < 5; i++) {
      results.push(b.recordAndCheck())
      t += 10 // small advance so timestamps differ
    }
    expect(results).toEqual([true, true, true, true, true])
    expect(b.used()).toBe(5)
  })

  it('6th call returns false and used() stays at 5', () => {
    let t = 0
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    for (let i = 0; i < 5; i++) {
      b.recordAndCheck()
      t += 10
    }
    const sixth = b.recordAndCheck()
    expect(sixth).toBe(false)
    expect(b.used()).toBe(5)
  })
})

describe('RestartBudget — sliding window', () => {
  it('refills after advancing now() past windowMs', () => {
    let t = 0
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    for (let i = 0; i < 5; i++) {
      b.recordAndCheck()
      t += 10
    }
    expect(b.recordAndCheck()).toBe(false)

    // Advance past entire window so all timestamps expire
    t += 60_001
    expect(b.recordAndCheck()).toBe(true)
  })

  it('sliding window drops only expired timestamps', () => {
    let t = 0
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })

    // 3 calls at t=0
    b.recordAndCheck()
    b.recordAndCheck()
    b.recordAndCheck()

    // Advance halfway through the window
    t = 30_001

    // 2 more calls at t=30_001
    b.recordAndCheck()
    b.recordAndCheck()

    // All 5 should still be active
    expect(b.used()).toBe(5)

    // Advance just past the FIRST call's window expiry (t=0+60_000=60_000)
    // At t=60_001: timestamps at 0 are expired (0 > 60_001-60_000=1 → false → drop)
    // Timestamps at 30_001 are still active (30_001 > 1 → true → keep)
    t = 60_001
    expect(b.used()).toBe(2)
  })
})

describe('RestartBudget — reset', () => {
  it('reset() clears all timestamps and used() returns 0', () => {
    const t = 0
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    b.recordAndCheck()
    b.recordAndCheck()
    b.recordAndCheck()
    expect(b.used()).toBe(3)

    b.reset()
    expect(b.used()).toBe(0)
  })

  it('recordAndCheck() succeeds again after reset', () => {
    const t = 0
    const b = new RestartBudget({ max: 2, windowMs: 60_000, now: () => t })
    b.recordAndCheck()
    b.recordAndCheck()
    expect(b.recordAndCheck()).toBe(false)

    b.reset()
    expect(b.recordAndCheck()).toBe(true)
  })
})

describe('RestartBudget — windowEndsAt', () => {
  it('windowEndsAt() returns now+windowMs when empty', () => {
    const t = 5_000
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    expect(b.windowEndsAt()).toBe(new Date(5_000 + 60_000).toISOString())
  })

  it('windowEndsAt() returns firstEntry+windowMs when populated', () => {
    let t = 1_000
    const b = new RestartBudget({ max: 5, windowMs: 60_000, now: () => t })
    b.recordAndCheck() // timestamp = 1_000
    t = 2_000
    b.recordAndCheck() // timestamp = 2_000
    // oldest is 1_000, so windowEndsAt = 1_000 + 60_000 = 61_000
    expect(b.windowEndsAt()).toBe(new Date(61_000).toISOString())
  })
})
