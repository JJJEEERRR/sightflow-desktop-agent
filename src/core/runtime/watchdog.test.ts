import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lifecycle } from './lifecycle'
import { Watchdog, type WatchdogClock } from './watchdog'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

/**
 * Deterministic clock for Watchdog tests. Registered timers carry an absolute
 * fire-time computed against a virtual `now`. `tick` advances `now` and fires
 * every timer whose deadline is now ≤ current time. `random()` is fixed so
 * jitter is predictable.
 */
class FakeClock implements WatchdogClock {
  private now = 0
  private nextId = 1
  private timeouts = new Map<number, { at: number; fn: () => void }>()
  private intervals = new Map<number, { every: number; nextAt: number; fn: () => void }>()
  randomValue = 0.5

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timeouts.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimeout(token: unknown): void {
    this.timeouts.delete(token as number)
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++
    this.intervals.set(id, { every: ms, nextAt: this.now + ms, fn })
    return id
  }
  clearInterval(token: unknown): void {
    this.intervals.delete(token as number)
  }
  random(): number {
    return this.randomValue
  }

  /**
   * Advance the virtual clock by `ms` and fire all timers due in that window.
   * Returns a promise so callers can `await` microtask flushing in one step.
   */
  async tick(ms: number): Promise<void> {
    this.now += ms
    const due: Array<() => void> = []

    for (const [id, t] of [...this.timeouts]) {
      if (t.at <= this.now) {
        due.push(t.fn)
        this.timeouts.delete(id)
      }
    }
    for (const [, t] of this.intervals) {
      while (t.nextAt <= this.now) {
        due.push(t.fn)
        t.nextAt += t.every
      }
    }
    for (const fn of due) fn()
    // Flush microtasks queued by the timer callbacks. Two ticks of the
    // microtask queue handles the common "await once + return" patterns.
    await Promise.resolve()
    await Promise.resolve()
  }
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
  vi.restoreAllMocks()
})

describe('Watchdog — recovery on crash', () => {
  it('schedules recovery after a crash and drives the lifecycle through recover()', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start() // idle → running

    const restart = vi.fn(async (): Promise<void> => {
      // Simulate a successful engine restart: engine would call recovered().
      lc.recovered()
    })

    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 1000,
      jitterFraction: 0 // deterministic timing
    })
    wd.start()

    lc.crash(new Error('boom'))
    expect(lc.getState()).toBe('crashed')

    // Before the timer fires, restart should not have been called yet.
    await Promise.resolve()
    expect(restart).not.toHaveBeenCalled()

    await clock.tick(1000)
    // Fake recovery flow:
    //   timer fires → attemptRecovery → lifecycle.recover() (recovering)
    //   → restartFn() → restartFn calls lc.recovered() → running
    expect(restart).toHaveBeenCalledOnce()
    expect(lc.getState()).toBe('running')
    expect(wd.getStats().attempts).toBe(1)
    expect(wd.getStats().givenUp).toBe(false)
  })

  it('respects the restart budget; gives up after exhaustion', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle({ restartBudget: { max: 2, windowMs: 60_000 } })
    lc.start()

    // restart "works" by transitioning through recovered → running, then we
    // immediately crash again to simulate a flapping engine.
    const restart = vi.fn(async (): Promise<void> => {
      lc.recovered()
    })

    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 100,
      jitterFraction: 0
    })
    wd.start()

    // Crash #1
    lc.crash(new Error('1'))
    await clock.tick(100)
    expect(lc.getState()).toBe('running')
    expect(wd.getStats().attempts).toBe(1)

    // Crash #2
    lc.crash(new Error('2'))
    await clock.tick(200)
    expect(lc.getState()).toBe('running')
    expect(wd.getStats().attempts).toBe(2)

    // Crash #3 — budget should now be exhausted (max=2).
    lc.crash(new Error('3'))
    // `tick` further than any reasonable backoff to make sure we observe the
    // give-up branch and not a still-pending timer.
    await clock.tick(60_000)
    expect(lc.getState()).toBe('crashed')
    expect(wd.getStats().attempts).toBe(3)
    expect(wd.getStats().givenUp).toBe(true)
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('re-crashes the lifecycle when restart() throws', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()

    const restart = vi
      .fn<[], Promise<void>>()
      .mockRejectedValueOnce(new Error('rebuild failed'))
      .mockImplementation(async () => {
        lc.recovered()
      })

    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 500,
      jitterFraction: 0
    })
    wd.start()

    lc.crash(new Error('initial'))
    await clock.tick(500)
    // First attempt rejects → lifecycle pushed back to crashed, scheduling
    // another attempt at 2x the base.
    expect(lc.getState()).toBe('crashed')
    expect(wd.getStats().attempts).toBe(1)

    // 2 ** 1 * 500 = 1000ms for attempt #2.
    await clock.tick(1000)
    expect(lc.getState()).toBe('running')
    expect(restart).toHaveBeenCalledTimes(2)
  })
})

describe('Watchdog — backoff math', () => {
  it('doubles the base delay each attempt up to maxDelayMs', async () => {
    const clock = new FakeClock()
    clock.randomValue = 0.5 // jitter contribution = 0
    const lc = new Lifecycle({ restartBudget: { max: 100, windowMs: 60_000 } })
    lc.start()

    let restartCount = 0
    const restart = vi.fn(async (): Promise<void> => {
      restartCount++
      lc.recovered()
    })

    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitterFraction: 0 // make assertions exact
    })
    wd.start()

    // attempts=0 → delay = min(5000, 1000*1) = 1000
    lc.crash(new Error('a'))
    expect(wd.getStats().lastDelayMs).toBe(1000)
    await clock.tick(1000)
    expect(restartCount).toBe(1)

    // attempts=1 → delay = min(5000, 1000*2) = 2000
    lc.crash(new Error('b'))
    expect(wd.getStats().lastDelayMs).toBe(2000)
    await clock.tick(2000)
    expect(restartCount).toBe(2)

    // attempts=2 → delay = min(5000, 1000*4) = 4000
    lc.crash(new Error('c'))
    expect(wd.getStats().lastDelayMs).toBe(4000)
    await clock.tick(4000)
    expect(restartCount).toBe(3)

    // attempts=3 → delay = min(5000, 1000*8) = 5000 (capped)
    lc.crash(new Error('d'))
    expect(wd.getStats().lastDelayMs).toBe(5000)

    // attempts=4 → still capped at 5000
    await clock.tick(5000)
    lc.crash(new Error('e'))
    expect(wd.getStats().lastDelayMs).toBe(5000)
  })

  it('keeps jitter inside the configured fraction', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    const wd = new Watchdog({
      lifecycle: lc,
      restart: async () => {},
      clock,
      baseDelayMs: 1000,
      jitterFraction: 0.5
    })

    // We can't easily observe internal computeDelay across many randoms, but
    // we can sample a few random values and assert lastDelayMs lands inside
    // the allowed window after each crash.
    lc.start()
    wd.start()
    for (const r of [0, 0.25, 0.75, 1]) {
      clock.randomValue = r
      lc.crash(new Error(`r=${r}`))
      const delay = wd.getStats().lastDelayMs
      // Without restoration of attempts via budget mutation we'd be at 0
      // attempts each time before recover(), so base = 1000.
      // jitter range = base * 0.5 = 500 → delay ∈ [500, 1500].
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(1500)
      // Recover the lifecycle manually so we can crash again.
      lc.recover()
      lc.recovered()
    }
  })
})

describe('Watchdog — lifecycle interaction', () => {
  it('stop() cancels a pending recovery timer', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()
    const restart = vi.fn(async (): Promise<void> => {
      lc.recovered()
    })
    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 1000,
      jitterFraction: 0
    })
    wd.start()
    lc.crash(new Error('x'))

    wd.stop()
    await clock.tick(5000)
    expect(restart).not.toHaveBeenCalled()
  })

  it('start() is idempotent', () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    const wd = new Watchdog({
      lifecycle: lc,
      restart: async () => {},
      clock
    })
    wd.start()
    wd.start()
    // Two starts should not double-subscribe; we can't easily inspect that
    // directly without poking internals, but we can assert no error is thrown
    // here and that a single crash schedules exactly one attempt at the right
    // time.
    lc.start()
    lc.crash(new Error('once'))
    expect(wd.getStats().lastDelayMs).toBeGreaterThan(0)
  })

  it('aborts recovery if state changed before the timer fires', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()
    const restart = vi.fn(async (): Promise<void> => {
      lc.recovered()
    })
    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 1000,
      jitterFraction: 0
    })
    wd.start()
    lc.crash(new Error('x'))
    // User stops the engine; lifecycle goes crashed → stopped manually.
    lc.stop()
    await clock.tick(2000)
    expect(restart).not.toHaveBeenCalled()
  })

  it('attaches to an already-crashed lifecycle on start()', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()
    lc.crash(new Error('pre-existing'))

    const restart = vi.fn(async (): Promise<void> => {
      lc.recovered()
    })
    const wd = new Watchdog({
      lifecycle: lc,
      restart,
      clock,
      baseDelayMs: 250,
      jitterFraction: 0
    })
    wd.start()

    await clock.tick(250)
    expect(restart).toHaveBeenCalledOnce()
    expect(lc.getState()).toBe('running')
  })
})

describe('Watchdog — liveness probe', () => {
  it('crashes the lifecycle after consecutive liveness failures', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()

    const liveness = vi
      .fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)

    const wd = new Watchdog({
      lifecycle: lc,
      restart: async () => {
        lc.recovered()
      },
      clock,
      livenessCheck: liveness,
      livenessIntervalMs: 100,
      livenessFailureThreshold: 3,
      baseDelayMs: 50,
      jitterFraction: 0
    })
    wd.start()

    // Three liveness ticks → threshold breached → lifecycle.crash().
    await clock.tick(100)
    await clock.tick(100)
    await clock.tick(100)
    expect(liveness).toHaveBeenCalledTimes(3)
    expect(lc.getState()).toBe('crashed')
    expect(wd.getStats().livenessFailures).toBeGreaterThanOrEqual(3)
  })

  it('resets the failure counter on a successful liveness response', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()

    const liveness = vi
      .fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) // resets here
      .mockResolvedValue(false)

    const wd = new Watchdog({
      lifecycle: lc,
      restart: async () => {},
      clock,
      livenessCheck: liveness,
      livenessIntervalMs: 100,
      livenessFailureThreshold: 3,
      jitterFraction: 0
    })
    wd.start()

    await clock.tick(100) // false → 1
    await clock.tick(100) // false → 2
    await clock.tick(100) // true → 0
    expect(wd.getStats().livenessFailures).toBe(0)
    // Fourth tick (false) → counter goes from 0 to 1, NOT to threshold.
    await clock.tick(100)
    expect(lc.getState()).toBe('running')
    expect(wd.getStats().livenessFailures).toBe(1)
  })

  it('stops the liveness timer when the lifecycle leaves running', async () => {
    const clock = new FakeClock()
    const lc = new Lifecycle()
    lc.start()

    const liveness = vi.fn<[], Promise<boolean>>().mockResolvedValue(true)

    const wd = new Watchdog({
      lifecycle: lc,
      restart: async () => {},
      clock,
      livenessCheck: liveness,
      livenessIntervalMs: 100,
      jitterFraction: 0
    })
    wd.start()

    await clock.tick(100)
    expect(liveness).toHaveBeenCalledTimes(1)

    lc.pause('user')
    // Timer should be cancelled; further ticks must not invoke the probe.
    await clock.tick(500)
    expect(liveness).toHaveBeenCalledTimes(1)
  })
})
