import { useEffect } from 'react'
import { useEngineStore } from '../stores/engine'

/**
 * Subscribes the global engine store to push events from the main process.
 *
 * Mounted once at the top of the app (by `AppLayout`). Routes:
 *  - `engine:state` → `engineStore.status` (when payload is a coarse status
 *    string; the diagnostics panel separately consumes the rich
 *    LifecycleStatePayload shape via its own subscriber).
 *  - `engine:log` errors → `engineStore.lastError`.
 *
 * The narrow status-string check is defensive: today's main-side emission
 * uses the rich LifecycleStatePayload, so this is a no-op for normal traffic
 * — but the contract leaves room for future coarse-status messages without
 * needing renderer plumbing changes.
 */
export function useEngineSubscription(): void {
  useEffect(() => {
    const offState = window.electron?.on('engine:state', (...args) => {
      const status = args[0]
      if (status === 'idle' || status === 'running' || status === 'error') {
        useEngineStore.getState().setStatus(status)
      }
    })
    const offLog = window.electron?.on('engine:log', (...args) => {
      const payload = args[0] as { type?: string; content?: string } | undefined
      if (payload?.type === 'error' && typeof payload.content === 'string') {
        useEngineStore.getState().setLastError(payload.content)
      }
    })
    return (): void => {
      offState?.()
      offLog?.()
    }
  }, [])
}
