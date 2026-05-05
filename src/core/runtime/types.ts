export type LifecycleState = 'idle' | 'running' | 'paused' | 'crashed' | 'recovering' | 'stopped'

export type PauseReason =
  | 'user' // user clicked pause
  | 'breaker' // anti-detection circuit breaker tripped (Phase 3)
  | 'permission' // OS permission dropped (e.g. screen recording revoked)
  | 'external' // explicit pauseForHuman() called from main process

export interface LifecycleSnapshot {
  state: LifecycleState
  enteredAt: string // ISO 8601 of last transition
  pauseReason?: PauseReason // present iff state==='paused'
  lastError?: { name: string; message: string } // present iff state in ('crashed','recovering')
  restartBudget: {
    used: number
    max: number
    windowEndsAt: string // ISO 8601
  }
}

export interface LifecycleEvent {
  from: LifecycleState
  to: LifecycleState
  at: string // ISO 8601
  reason?: string // e.g. PauseReason or recover-attempt#N
  data?: Record<string, unknown>
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: LifecycleState,
    public readonly attempted: string
  ) {
    super(`Illegal lifecycle transition: cannot ${attempted} from state '${from}'`)
    this.name = 'IllegalTransitionError'
  }
}
