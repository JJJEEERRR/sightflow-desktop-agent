import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useEngineStore } from '../stores/engine'
import type { LifecycleStatePayload } from '../types'

/**
 * Subscribes the global engine store + react-query cache to push events from
 * the main process. Mounted once at the top of the app (by `AppLayout`).
 *
 * Routes:
 *  - `engine:state` (rich `LifecycleStatePayload`) →
 *      • `useEngineStore.status` (mapped from snapshot.state for the
 *        coarse running/idle/error indicator).
 *      • `queryClient` cache key `['engine:lifecycle']` so any consumer
 *        using `useQuery({ queryKey: ['engine:lifecycle'] })` (e.g.
 *        DiagnosticsPanel) re-renders without an additional IPC roundtrip.
 *  - `engine:state` (legacy coarse status string) → engineStore.status.
 *  - `engine:log` errors → engineStore.lastError.
 *
 * The narrow status-string check is defensive: today's main-side emission
 * uses the rich LifecycleStatePayload, so the string branch is a no-op for
 * normal traffic — but the contract leaves room for future coarse-status
 * messages without needing renderer plumbing changes.
 *
 * PR2 widened this hook from "engine store only" to "engine store + cache"
 * to keep a single source of truth between the initial `useQuery` backfill
 * and the live push channel — see ADR-0013 migration outcome.
 */
export function useEngineSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const offState = window.electron?.on('engine:state', (...args) => {
      const payload = args[0]
      if (typeof payload === 'string') {
        if (payload === 'idle' || payload === 'running' || payload === 'error') {
          useEngineStore.getState().setStatus(payload)
        }
        return
      }
      const lifecycle = payload as LifecycleStatePayload | undefined
      if (!lifecycle?.snapshot) return
      queryClient.setQueryData(['engine:lifecycle'], lifecycle.snapshot)
      const state = lifecycle.snapshot.state
      if (state === 'running') useEngineStore.getState().setStatus('running')
      else if (state === 'crashed') useEngineStore.getState().setStatus('error')
      else if (state === 'idle' || state === 'stopped') useEngineStore.getState().setStatus('idle')
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
  }, [queryClient])
}
