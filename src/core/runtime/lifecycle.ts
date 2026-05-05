import type { LifecycleState, PauseReason, LifecycleSnapshot, LifecycleEvent } from './types'
import { IllegalTransitionError } from './types'
import { RestartBudget } from './restart-budget'

export interface LifecycleOptions {
  /** Restart budget configuration. Defaults: max=5, windowMs=3_600_000 (1h). */
  restartBudget?: { max: number; windowMs: number }
  /** Clock injection for testability. Defaults to `Date.now`. */
  now?: () => number
}

export class Lifecycle {
  private state: LifecycleState
  private enteredAt: number
  private pauseReason: PauseReason | undefined
  private lastError: { name: string; message: string } | undefined
  private readonly budget: RestartBudget
  private readonly budgetMax: number
  private readonly now: () => number
  private listeners: Array<(event: LifecycleEvent) => void>

  constructor(opts?: LifecycleOptions) {
    this.now = opts?.now ?? ((): number => Date.now())
    this.enteredAt = this.now()
    this.state = 'idle'
    this.pauseReason = undefined
    this.lastError = undefined
    this.listeners = []
    const budgetConfig = opts?.restartBudget ?? { max: 5, windowMs: 3_600_000 }
    this.budgetMax = budgetConfig.max
    this.budget = new RestartBudget({ ...budgetConfig, now: this.now })
  }

  /** Dispatch a state transition and fire all currently-registered listeners. */
  private transition(
    from: LifecycleState,
    to: LifecycleState,
    reason?: string,
    data?: Record<string, unknown>
  ): void {
    this.state = to
    this.enteredAt = this.now()
    const event: LifecycleEvent = {
      from,
      to,
      at: new Date(this.enteredAt).toISOString(),
      reason,
      data
    }
    // Snapshot listeners before dispatch; subscribers added during a transition
    // do NOT fire for that transition.
    const snapshot = this.listeners.slice()
    for (const listener of snapshot) {
      try {
        listener(event)
      } catch (err) {
        // Listeners must not disrupt state or skip subsequent listeners.
        console.error('Lifecycle subscriber threw:', err)
      }
    }
  }

  // ── Transition methods ───────────────────────────────────────────────────

  /** idle → running */
  start(): void {
    if (this.state !== 'idle') {
      throw new IllegalTransitionError(this.state, 'start')
    }
    this.transition('idle', 'running')
  }

  /** running → paused */
  pause(reason: PauseReason): void {
    if (this.state !== 'running') {
      throw new IllegalTransitionError(this.state, 'pause')
    }
    this.pauseReason = reason
    this.transition('running', 'paused', reason)
  }

  /** paused → running */
  resume(): void {
    if (this.state !== 'paused') {
      throw new IllegalTransitionError(this.state, 'resume')
    }
    const from = this.state
    this.pauseReason = undefined
    this.transition(from, 'running')
  }

  /** running|recovering → crashed */
  crash(err: Error): void {
    if (this.state !== 'running' && this.state !== 'recovering') {
      throw new IllegalTransitionError(this.state, 'crash')
    }
    const from = this.state
    this.lastError = { name: err.name, message: err.message }
    this.transition(from, 'crashed')
  }

  /**
   * crashed → recovering iff budget allows.
   * Returns true if transitioned to recovering, false if budget exhausted (state stays crashed).
   */
  recover(): boolean {
    if (this.state !== 'crashed') {
      throw new IllegalTransitionError(this.state, 'recover')
    }
    const allowed = this.budget.recordAndCheck()
    if (!allowed) {
      return false
    }
    const attemptNum = this.budget.used()
    this.transition('crashed', 'recovering', `recover-attempt#${attemptNum}`)
    return true
  }

  /** recovering → running; clears lastError */
  recovered(): void {
    if (this.state !== 'recovering') {
      throw new IllegalTransitionError(this.state, 'recovered')
    }
    this.lastError = undefined
    this.transition('recovering', 'running')
  }

  /** {running, paused, crashed} → stopped */
  stop(): void {
    if (this.state !== 'running' && this.state !== 'paused' && this.state !== 'crashed') {
      throw new IllegalTransitionError(this.state, 'stop')
    }
    const from = this.state
    this.transition(from, 'stopped')
  }

  // ── Inspection ──────────────────────────────────────────────────────────

  getState(): LifecycleState {
    return this.state
  }

  snapshot(): LifecycleSnapshot {
    const snap: LifecycleSnapshot = {
      state: this.state,
      enteredAt: new Date(this.enteredAt).toISOString(),
      restartBudget: {
        used: this.budget.used(),
        max: this.budgetMax,
        windowEndsAt: this.budget.windowEndsAt()
      }
    }
    if (this.pauseReason !== undefined) {
      snap.pauseReason = this.pauseReason
    }
    if (this.lastError !== undefined) {
      snap.lastError = this.lastError
    }
    return snap
  }

  /** Returns true when the lifecycle has reached the terminal 'stopped' state. */
  isTerminal(): boolean {
    return this.state === 'stopped'
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  /**
   * Register a listener that fires synchronously after each state transition.
   * Returns an unsubscribe function; calling it multiple times is safe (no-op).
   */
  subscribe(listener: (event: LifecycleEvent) => void): () => void {
    this.listeners.push(listener)
    let subscribed = true
    return (): void => {
      if (!subscribed) return
      subscribed = false
      const idx = this.listeners.indexOf(listener)
      if (idx !== -1) {
        this.listeners.splice(idx, 1)
      }
    }
  }
}
