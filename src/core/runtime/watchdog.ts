/**
 * Watchdog — auto-recovery loop sitting on top of the Lifecycle FSM.
 *
 * Responsibilities:
 *   1. Listen for `crashed` transitions on a shared `Lifecycle`.
 *   2. Wait an exponential-backoff delay (jittered, capped).
 *   3. Call `lifecycle.recover()`. If the budget is exhausted, give up.
 *   4. Invoke `restart()` — supplied by main, rebuilds + starts the engine.
 *   5. The Engine itself transitions `recovering → running` via
 *      `lifecycle.recovered()` once it reaches a steady state. If `restart`
 *      throws (or the rebuilt engine crashes again), the lifecycle re-enters
 *      `crashed` and the Watchdog loop kicks in again.
 *
 * The recovery budget lives on the Lifecycle (RestartBudget). The Watchdog
 * never tracks attempts itself beyond the timer state needed for cancellation.
 */

import type { LifecycleEvent } from './types'
import type { Lifecycle } from './lifecycle'
import { getLogger } from '../observability'

export interface WatchdogClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(token: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(token: unknown): void
  random(): number
}

const realClock: WatchdogClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
  random: () => Math.random()
}

export interface WatchdogOptions {
  lifecycle: Lifecycle
  /**
   * Builds + starts a fresh Engine using the same shared Lifecycle. Resolves
   * once `engine.start()` has been *kicked off* (does NOT await the loop —
   * that runs forever). Rejects if construction or kickoff throws synchronously.
   */
  restart: () => Promise<void>

  /** Initial delay before the first recovery attempt (default: 1_000 ms). */
  baseDelayMs?: number
  /** Hard cap on the backoff delay (default: 60_000 ms). */
  maxDelayMs?: number
  /** ±fraction of the computed delay to randomise over (default: 0.2). */
  jitterFraction?: number

  /**
   * Optional liveness probe; called every `livenessIntervalMs` while the
   * lifecycle is in `running`. If it returns false (or throws)
   * `livenessFailureThreshold` times in a row, the lifecycle is force-crashed
   * with reason "liveness".
   */
  livenessCheck?: () => Promise<boolean>
  livenessIntervalMs?: number
  livenessFailureThreshold?: number

  /** Clock injection for deterministic tests. Defaults to real timers. */
  clock?: WatchdogClock
}

export interface WatchdogStats {
  /** Number of recover() calls attempted (independent of restart budget). */
  attempts: number
  /** Last computed backoff in ms (post-jitter). */
  lastDelayMs: number
  /** Consecutive failed livenessCheck invocations (resets on success). */
  livenessFailures: number
  /** True once the watchdog has stopped trying due to budget exhaustion. */
  givenUp: boolean
}

export class Watchdog {
  private readonly lifecycle: Lifecycle
  private readonly restartFn: () => Promise<void>
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterFraction: number
  private readonly livenessCheck?: () => Promise<boolean>
  private readonly livenessIntervalMs: number
  private readonly livenessFailureThreshold: number
  private readonly clock: WatchdogClock
  private readonly log = getLogger('watchdog')

  private unsubscribe: (() => void) | null = null
  private pendingTimer: unknown = null
  private livenessTimer: unknown = null
  private livenessInFlight = false
  private stats: WatchdogStats = {
    attempts: 0,
    lastDelayMs: 0,
    livenessFailures: 0,
    givenUp: false
  }

  constructor(opts: WatchdogOptions) {
    this.lifecycle = opts.lifecycle
    this.restartFn = opts.restart
    this.baseDelayMs = opts.baseDelayMs ?? 1_000
    this.maxDelayMs = opts.maxDelayMs ?? 60_000
    this.jitterFraction = opts.jitterFraction ?? 0.2
    if (opts.livenessCheck) {
      this.livenessCheck = opts.livenessCheck
    }
    this.livenessIntervalMs = opts.livenessIntervalMs ?? 30_000
    this.livenessFailureThreshold = opts.livenessFailureThreshold ?? 3
    this.clock = opts.clock ?? realClock
  }

  /** Subscribes to lifecycle events. Idempotent. */
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.lifecycle.subscribe((evt) => this.handleTransition(evt))

    // If we attached after the lifecycle already entered a state we care
    // about (e.g. running), kick the relevant side effect.
    const cur = this.lifecycle.getState()
    if (cur === 'running') {
      this.startLivenessTimer()
    } else if (cur === 'crashed') {
      this.scheduleRecovery()
    }
    this.log.info('Watchdog started', { state: cur })
  }

  /** Unsubscribes, cancels pending recovery and liveness timers. Safe to repeat. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.cancelRecovery()
    this.stopLivenessTimer()
    this.log.info('Watchdog stopped', { ...this.stats })
  }

  getStats(): WatchdogStats {
    return { ...this.stats }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private handleTransition(evt: LifecycleEvent): void {
    switch (evt.to) {
      case 'crashed':
        this.scheduleRecovery()
        break
      case 'running':
        // Reset liveness counter and (re)start the probe timer when we're back
        // up. `recovered()` from the engine fires this branch via the same
        // listener, so no separate hook is needed.
        this.stats.livenessFailures = 0
        this.startLivenessTimer()
        break
      case 'stopped':
      case 'paused':
      case 'recovering':
      case 'idle':
        // No timer should run while we're not running. Recovery scheduling
        // for `recovering` is the engine's job (it transitioned us there).
        this.stopLivenessTimer()
        break
    }
  }

  private scheduleRecovery(): void {
    if (this.stats.givenUp) return
    if (this.pendingTimer !== null) return

    const used = this.lifecycle.snapshot().restartBudget.used
    const delay = this.computeDelay(used)
    this.stats.lastDelayMs = delay
    this.log.info('Recovery scheduled', { delay, attemptsBefore: used })

    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null
      void this.attemptRecovery()
    }, delay)
  }

  private cancelRecovery(): void {
    if (this.pendingTimer !== null) {
      this.clock.clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  private async attemptRecovery(): Promise<void> {
    if (this.lifecycle.getState() !== 'crashed') {
      // State changed underneath us (e.g. user manually stopped). Bail.
      this.log.info('Recovery aborted; lifecycle no longer crashed', {
        state: this.lifecycle.getState()
      })
      return
    }

    const allowed = this.lifecycle.recover()
    this.stats.attempts++
    if (!allowed) {
      this.stats.givenUp = true
      this.log.error('Restart budget exhausted; watchdog giving up')
      return
    }

    try {
      await this.restartFn()
      // Engine drives `recovering → running` once it has finished bootstrap
      // (see `Engine.start()`). Nothing to do here on the happy path.
    } catch (err) {
      // restart() threw before the engine could even kick off. Push the
      // lifecycle back to crashed so the next listener tick reschedules.
      const error = err instanceof Error ? err : new Error(String(err))
      this.log.error('restart() threw; re-crashing lifecycle', { err: error })
      try {
        // crash() is legal from `recovering`. If the state has already
        // advanced (e.g. to running and immediately crashed), this throws
        // an IllegalTransitionError — swallow and let the next 'crashed'
        // event re-enter scheduleRecovery.
        this.lifecycle.crash(error)
      } catch (illegal) {
        this.log.warn('Could not re-crash lifecycle from current state', {
          state: this.lifecycle.getState(),
          err: illegal
        })
      }
    }
  }

  private computeDelay(attempts: number): number {
    const base = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempts)
    const jitterRange = base * this.jitterFraction
    const jitter = (this.clock.random() * 2 - 1) * jitterRange
    return Math.max(0, Math.round(base + jitter))
  }

  // ── Liveness probe ───────────────────────────────────────────────────────

  private startLivenessTimer(): void {
    if (!this.livenessCheck) return
    if (this.livenessTimer !== null) return
    this.stats.livenessFailures = 0
    this.livenessTimer = this.clock.setInterval(() => {
      void this.runLivenessCheck()
    }, this.livenessIntervalMs)
  }

  private stopLivenessTimer(): void {
    if (this.livenessTimer !== null) {
      this.clock.clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private async runLivenessCheck(): Promise<void> {
    if (!this.livenessCheck) return
    if (this.livenessInFlight) return // skip overlap; better to miss a tick than queue
    if (this.lifecycle.getState() !== 'running') return
    this.livenessInFlight = true
    try {
      const ok = await this.livenessCheck()
      if (ok) {
        this.stats.livenessFailures = 0
      } else {
        this.recordLivenessFailure(new Error('liveness check returned false'))
      }
    } catch (err) {
      this.recordLivenessFailure(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.livenessInFlight = false
    }
  }

  private recordLivenessFailure(err: Error): void {
    this.stats.livenessFailures++
    this.log.warn('Liveness check failed', {
      consecutive: this.stats.livenessFailures,
      threshold: this.livenessFailureThreshold,
      err
    })
    if (this.stats.livenessFailures >= this.livenessFailureThreshold) {
      this.log.error('Liveness threshold breached; force-crashing lifecycle', {
        threshold: this.livenessFailureThreshold
      })
      // Defensive: only crash from a state where it's legal. If the engine
      // already crashed for another reason between probe and reaction, skip.
      if (this.lifecycle.getState() === 'running') {
        try {
          this.lifecycle.crash(new Error(`liveness: ${err.message}`))
        } catch (illegal) {
          this.log.warn('Could not crash from liveness; lifecycle moved', {
            err: illegal
          })
        }
      }
    }
  }
}
