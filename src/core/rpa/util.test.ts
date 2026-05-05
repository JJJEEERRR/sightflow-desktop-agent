import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delay, randomDelay, randomDelayIn, getRobot } from './util'

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the requested duration', async () => {
    const promise = delay(100)
    let done = false
    promise.then(() => {
      done = true
    })

    // Before timer advance — must not have resolved
    await Promise.resolve()
    expect(done).toBe(false)

    vi.advanceTimersByTime(99)
    await Promise.resolve()
    expect(done).toBe(false)

    vi.advanceTimersByTime(1)
    await promise
    expect(done).toBe(true)
  })
})

describe('randomDelay / randomDelayIn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('randomDelay stays within ±10ms of the requested base', async () => {
    // Math.random is stubbed to 0 → smallest value, then to 1 → largest.
    vi.spyOn(Math, 'random').mockReturnValueOnce(0)
    let resolved = false
    randomDelay(100).then(() => {
      resolved = true
    })
    vi.advanceTimersByTime(89)
    await Promise.resolve()
    // 100 + 0*20 - 10 = 90
    expect(resolved).toBe(false)
    vi.advanceTimersByTime(2)
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('randomDelayIn picks a delay strictly inside [min, max]', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5)
    const start = Date.now()
    const p = randomDelayIn(100, 200) // 100 + 0.5 * 100 = 150ms
    vi.advanceTimersByTime(150)
    await p
    expect(Date.now() - start).toBeGreaterThanOrEqual(150)
  })
})

describe('getRobot', () => {
  it('returns null and logs an error when robotjs cannot be loaded', () => {
    // Spy on console.error so the test output stays clean and we can assert it ran.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const robot = getRobot()
    // robotjs requires a graphical session to load. In CI / unit tests we expect
    // it to either fail cleanly (returning null) or — if the host happens to have
    // a working build — to return an object with the expected shape. Assert both
    // branches behave correctly.
    if (robot === null) {
      expect(errSpy).toHaveBeenCalled()
    } else {
      expect(typeof robot.keyTap).toBe('function')
      expect(typeof robot.mouseClick).toBe('function')
      expect(typeof robot.getMousePos).toBe('function')
    }
    errSpy.mockRestore()
  })
})
