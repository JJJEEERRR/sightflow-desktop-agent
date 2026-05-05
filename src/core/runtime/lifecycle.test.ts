import { describe, expect, it, vi } from 'vitest'
import { Lifecycle } from './lifecycle'
import { IllegalTransitionError } from './types'
import type { LifecycleEvent } from './types'

// Helper: build a Lifecycle with a controllable clock
function makeLC(opts?: { max?: number; windowMs?: number }): {
  lc: Lifecycle
  advanceMs: (ms: number) => void
} {
  let t = 1_000_000
  const now = (): number => t
  const lc = new Lifecycle({
    now,
    restartBudget: { max: opts?.max ?? 5, windowMs: opts?.windowMs ?? 3_600_000 }
  })
  return {
    lc,
    advanceMs: (ms: number): void => {
      t += ms
    }
  }
}

// ── Group 1: Initial state ──────────────────────────────────────────────────

describe('Lifecycle — initial state', () => {
  it('starts in idle state', () => {
    const { lc } = makeLC()
    expect(lc.getState()).toBe('idle')
    expect(lc.isTerminal()).toBe(false)
  })

  it('snapshot() shape is correct at construction', () => {
    const { lc } = makeLC()
    const snap = lc.snapshot()
    expect(snap.state).toBe('idle')
    expect(typeof snap.enteredAt).toBe('string')
    // ISO 8601 check
    expect(() => new Date(snap.enteredAt)).not.toThrow()
    expect(snap.pauseReason).toBeUndefined()
    expect(snap.lastError).toBeUndefined()
    expect(snap.restartBudget.used).toBe(0)
    expect(snap.restartBudget.max).toBe(5)
    expect(typeof snap.restartBudget.windowEndsAt).toBe('string')
  })
})

// ── Group 2: Legal transitions, happy path ──────────────────────────────────

describe('Lifecycle — legal transitions', () => {
  it('idle → start() → running', () => {
    const { lc } = makeLC()
    lc.start()
    expect(lc.getState()).toBe('running')
  })

  it('running → pause("user") → paused; snapshot has pauseReason', () => {
    const { lc } = makeLC()
    lc.start()
    lc.pause('user')
    expect(lc.getState()).toBe('paused')
    const snap = lc.snapshot()
    expect(snap.pauseReason).toBe('user')
  })

  it('paused → resume() → running; snapshot.pauseReason cleared', () => {
    const { lc } = makeLC()
    lc.start()
    lc.pause('user')
    lc.resume()
    expect(lc.getState()).toBe('running')
    expect(lc.snapshot().pauseReason).toBeUndefined()
  })

  it('running → crash(err) → crashed; lastError populated', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('something broke'))
    expect(lc.getState()).toBe('crashed')
    const snap = lc.snapshot()
    expect(snap.lastError).toEqual({ name: 'Error', message: 'something broke' })
  })

  it('crashed → recover() → recovering; returns true', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('oops'))
    const result = lc.recover()
    expect(result).toBe(true)
    expect(lc.getState()).toBe('recovering')
  })

  it('recovering → recovered() → running; lastError cleared', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('boom'))
    lc.recover()
    lc.recovered()
    expect(lc.getState()).toBe('running')
    expect(lc.snapshot().lastError).toBeUndefined()
  })

  it('recovering → crash() → crashed (consecutive failures)', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('first'))
    lc.recover()
    lc.crash(new Error('second'))
    expect(lc.getState()).toBe('crashed')
    expect(lc.snapshot().lastError?.message).toBe('second')
  })

  it('running → stop() → stopped; isTerminal() === true', () => {
    const { lc } = makeLC()
    lc.start()
    lc.stop()
    expect(lc.getState()).toBe('stopped')
    expect(lc.isTerminal()).toBe(true)
  })

  it('paused → stop() → stopped', () => {
    const { lc } = makeLC()
    lc.start()
    lc.pause('external')
    lc.stop()
    expect(lc.getState()).toBe('stopped')
  })

  it('crashed → stop() → stopped', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('fatal'))
    lc.stop()
    expect(lc.getState()).toBe('stopped')
  })
})

// ── Group 3: Illegal transitions ────────────────────────────────────────────

describe('Lifecycle — illegal transitions throw IllegalTransitionError', () => {
  it('resume() from idle, running, crashed, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => {
        const { lc } = makeLC()
        return lc // idle
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        return lc // running
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        return lc // crashed
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.resume()).toThrow(IllegalTransitionError)
    }
  })

  it('pause() from idle, paused, crashed, recovering, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => makeLC().lc, // idle
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.pause('user')
        return lc // paused
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        return lc // crashed
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        lc.recover()
        return lc // recovering
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.pause('user')).toThrow(IllegalTransitionError)
    }
  })

  it('start() from running, paused, crashed, recovering, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => {
        const { lc } = makeLC()
        lc.start()
        return lc // running
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.pause('user')
        return lc // paused
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        return lc // crashed
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        lc.recover()
        return lc // recovering
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.start()).toThrow(IllegalTransitionError)
    }
  })

  it('recover() from idle, running, paused, recovering, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => makeLC().lc, // idle
      () => {
        const { lc } = makeLC()
        lc.start()
        return lc // running
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.pause('user')
        return lc // paused
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        lc.recover()
        return lc // recovering
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.recover()).toThrow(IllegalTransitionError)
    }
  })

  it('recovered() from idle, running, paused, crashed, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => makeLC().lc, // idle
      () => {
        const { lc } = makeLC()
        lc.start()
        return lc // running
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.pause('user')
        return lc // paused
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.crash(new Error('x'))
        return lc // crashed
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.recovered()).toThrow(IllegalTransitionError)
    }
  })

  it('crash() from idle, paused, stopped throws', () => {
    const stateSetups: Array<() => Lifecycle> = [
      () => makeLC().lc, // idle
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.pause('user')
        return lc // paused
      },
      () => {
        const { lc } = makeLC()
        lc.start()
        lc.stop()
        return lc // stopped
      }
    ]
    for (const setup of stateSetups) {
      const lc = setup()
      expect(() => lc.crash(new Error('x'))).toThrow(IllegalTransitionError)
    }
  })

  it('stop() from idle and recovering throws', () => {
    const idle = makeLC().lc
    expect(() => idle.stop()).toThrow(IllegalTransitionError)

    const { lc: recovering } = makeLC()
    recovering.start()
    recovering.crash(new Error('x'))
    recovering.recover()
    expect(() => recovering.stop()).toThrow(IllegalTransitionError)
  })

  it('any operation on stopped throws IllegalTransitionError', () => {
    const makeStoppedLC = (): Lifecycle => {
      const { lc } = makeLC()
      lc.start()
      lc.stop()
      return lc
    }
    expect(() => makeStoppedLC().start()).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().pause('user')).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().resume()).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().crash(new Error('x'))).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().recover()).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().recovered()).toThrow(IllegalTransitionError)
    expect(() => makeStoppedLC().stop()).toThrow(IllegalTransitionError)
  })

  it('IllegalTransitionError exposes from and attempted fields', () => {
    const { lc } = makeLC()
    try {
      lc.pause('user') // illegal from idle
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError)
      if (err instanceof IllegalTransitionError) {
        expect(err.from).toBe('idle')
        expect(err.attempted).toBe('pause')
        expect(err.message).toContain('idle')
        expect(err.name).toBe('IllegalTransitionError')
      }
    }
  })
})

// ── Group 4: Restart budget ──────────────────────────────────────────────────

describe('Lifecycle — restart budget', () => {
  it('recover() returns true for all budget.max calls within window', () => {
    const { lc } = makeLC({ max: 3, windowMs: 60_000 })
    lc.start()

    const cycle = (): boolean => {
      lc.crash(new Error('x'))
      const result = lc.recover()
      if (result) lc.recovered()
      return result
    }

    expect(cycle()).toBe(true)
    expect(cycle()).toBe(true)
    expect(cycle()).toBe(true)
  })

  it('recover() returns false when budget is exhausted; state stays crashed', () => {
    const { lc } = makeLC({ max: 2, windowMs: 60_000 })
    lc.start()

    lc.crash(new Error('x'))
    lc.recover()
    lc.recovered()

    lc.crash(new Error('x'))
    lc.recover()
    lc.recovered()

    lc.crash(new Error('x'))
    const result = lc.recover()
    expect(result).toBe(false)
    expect(lc.getState()).toBe('crashed')
  })

  it('budget refills after advancing time past windowMs', () => {
    let t = 0
    const lc = new Lifecycle({ now: () => t, restartBudget: { max: 2, windowMs: 60_000 } })
    lc.start()

    lc.crash(new Error('x'))
    lc.recover()
    lc.recovered()

    lc.crash(new Error('x'))
    lc.recover()
    lc.recovered()

    lc.crash(new Error('x'))
    expect(lc.recover()).toBe(false) // exhausted

    // Advance past window
    t = 60_001
    expect(lc.recover()).toBe(true)
    expect(lc.getState()).toBe('recovering')
  })

  it('snapshot restartBudget reflects used/max/windowEndsAt correctly', () => {
    const { lc } = makeLC({ max: 5, windowMs: 3_600_000 })
    lc.start()
    lc.crash(new Error('x'))
    lc.recover()
    const snap = lc.snapshot()
    expect(snap.restartBudget.used).toBe(1)
    expect(snap.restartBudget.max).toBe(5)
    expect(typeof snap.restartBudget.windowEndsAt).toBe('string')
  })
})

// ── Group 5: Subscriptions ──────────────────────────────────────────────────

describe('Lifecycle — subscriptions', () => {
  it('subscribe(fn) returns unsubscribe; fn called once per legal transition', () => {
    const { lc } = makeLC()
    const events: LifecycleEvent[] = []
    lc.subscribe((e) => events.push(e))

    lc.start()
    lc.pause('user')
    lc.resume()

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ from: 'idle', to: 'running' })
    expect(events[1]).toMatchObject({ from: 'running', to: 'paused', reason: 'user' })
    expect(events[2]).toMatchObject({ from: 'paused', to: 'running' })
  })

  it('multiple subscribers all fire in registration order', () => {
    const { lc } = makeLC()
    const order: number[] = []
    lc.subscribe(() => order.push(1))
    lc.subscribe(() => order.push(2))
    lc.subscribe(() => order.push(3))

    lc.start()
    expect(order).toEqual([1, 2, 3])
  })

  it('unsubscribe stops further calls', () => {
    const { lc } = makeLC()
    const events: LifecycleEvent[] = []
    const unsub = lc.subscribe((e) => events.push(e))

    lc.start()
    expect(events).toHaveLength(1)

    unsub()
    lc.pause('user')
    expect(events).toHaveLength(1) // no new events after unsubscribe
  })

  it('calling unsubscribe twice is safe (no-op)', () => {
    const { lc } = makeLC()
    const events: LifecycleEvent[] = []
    const unsub = lc.subscribe((e) => events.push(e))

    unsub()
    expect(() => unsub()).not.toThrow()

    lc.start()
    expect(events).toHaveLength(0)
  })

  it('subscriber added during a transition does not fire for that transition', () => {
    const { lc } = makeLC()
    const outerEvents: LifecycleEvent[] = []
    const innerEvents: LifecycleEvent[] = []

    lc.subscribe((e) => {
      outerEvents.push(e)
      // Add a new subscriber during this dispatch
      lc.subscribe((inner) => innerEvents.push(inner))
    })

    lc.start() // outer fires, inner is added but should NOT fire for start()
    expect(outerEvents).toHaveLength(1)
    expect(innerEvents).toHaveLength(0) // not fired for start()

    lc.pause('user') // both should fire now
    expect(outerEvents).toHaveLength(2)
    expect(innerEvents).toHaveLength(1)
  })

  it('a subscriber that throws does not break the lifecycle or skip other subscribers', () => {
    const { lc } = makeLC()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const afterEvents: LifecycleEvent[] = []

    lc.subscribe(() => {
      throw new Error('subscriber error')
    })
    lc.subscribe((e) => afterEvents.push(e))

    lc.start()

    // State was updated correctly
    expect(lc.getState()).toBe('running')
    // Second subscriber still fired
    expect(afterEvents).toHaveLength(1)
    // Error was logged
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

// ── Group 6: Snapshot determinism ───────────────────────────────────────────

describe('Lifecycle — snapshot determinism', () => {
  it('snapshot() after pause("breaker") shows that reason', () => {
    const { lc } = makeLC()
    lc.start()
    lc.pause('breaker')
    expect(lc.snapshot().pauseReason).toBe('breaker')
  })

  it('snapshot() after crash shows lastError.message', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('boom'))
    expect(lc.snapshot().lastError?.message).toBe('boom')
    expect(lc.snapshot().lastError?.name).toBe('Error')
  })

  it('lastError persists in snapshot during recovering state', () => {
    const { lc } = makeLC()
    lc.start()
    lc.crash(new Error('crash-msg'))
    lc.recover()
    expect(lc.getState()).toBe('recovering')
    expect(lc.snapshot().lastError?.message).toBe('crash-msg')
  })

  it('enteredAt updates on every transition', () => {
    let t = 1_000
    const lc = new Lifecycle({ now: () => t, restartBudget: { max: 5, windowMs: 3_600_000 } })

    const t0 = lc.snapshot().enteredAt

    t = 2_000
    lc.start()
    const t1 = lc.snapshot().enteredAt

    t = 3_000
    lc.pause('user')
    const t2 = lc.snapshot().enteredAt

    expect(t0).not.toBe(t1)
    expect(t1).not.toBe(t2)
    expect(t1).toBe(new Date(2_000).toISOString())
    expect(t2).toBe(new Date(3_000).toISOString())
  })

  it('LifecycleEvent carries correct at timestamp matching enteredAt', () => {
    let t = 5_000
    const lc = new Lifecycle({ now: () => t, restartBudget: { max: 5, windowMs: 3_600_000 } })
    const events: LifecycleEvent[] = []
    lc.subscribe((e) => events.push(e))

    t = 10_000
    lc.start()

    expect(events[0].at).toBe(new Date(10_000).toISOString())
    expect(lc.snapshot().enteredAt).toBe(new Date(10_000).toISOString())
  })
})
