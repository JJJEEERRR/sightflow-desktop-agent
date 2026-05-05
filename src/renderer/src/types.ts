/**
 * Renderer-side mirrors of the structured types emitted by `core/observability`
 * and `core/runtime`. Kept here (rather than imported from the core module)
 * because Vite would otherwise inline the entire observability bundle into the
 * renderer; we only need the shapes for IPC payload typing.
 *
 * If these drift from the core types, the renderer will silently render
 * stale fields. The integration test in `App.test.tsx` uses fixtures that
 * mirror the same shape, so a divergence shows up as a test break.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string
  level: LogLevel
  phase: string
  msg: string
  traceId?: string
  data?: Record<string, unknown>
  err?: { name: string; message: string; stack?: string }
}

export type LifecycleState = 'idle' | 'running' | 'paused' | 'crashed' | 'recovering' | 'stopped'

export type PauseReason = 'user' | 'silentWindow' | 'rateLimit' | 'circuitBreak' | 'permissionLost'

export interface LifecycleSnapshot {
  state: LifecycleState
  enteredAt: string
  pauseReason?: PauseReason
  lastError?: { name: string; message: string }
  restartBudget: { used: number; max: number; windowEndsAt: string }
}

export interface LifecycleEvent {
  from: LifecycleState
  to: LifecycleState
  at: string
  reason?: string
  data?: Record<string, unknown>
}

export interface LifecycleStatePayload {
  event: LifecycleEvent
  snapshot: LifecycleSnapshot
}
