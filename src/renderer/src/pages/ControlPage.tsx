import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { useEngineStore } from '../stores/engine'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'
import { PlayIcon, StopIcon } from '../components/icons'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { StatusDot } from '../layout/AppLayout'
import type { AppKind } from '../types'

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
}

// Static map from the four log-entry types onto their concrete i18n keys.
// Keeping this as a literal-typed lookup (rather than building the key
// via template-string interpolation at the call site) preserves the
// compile-time key safety from `i18n/types.d.ts` — a `LogEntry['type']`
// gone wrong would fail to index this map, and a typo in any key would
// fail to satisfy the resource type.
const LOG_TYPE_KEY = {
  thinking: 'control.log.thinking',
  reply: 'control.log.reply',
  skip: 'control.log.skip',
  error: 'control.log.error'
} as const

const LOG_TYPE_COLOR: Record<LogEntry['type'], string> = {
  thinking: 'text-warning',
  reply: 'text-primary',
  skip: 'text-muted-foreground',
  error: 'text-destructive'
}

interface EngineLogPayload {
  type: string
  content: string
}

interface OkResult<T = unknown> {
  success: true
  data?: T
}

interface ErrResult {
  success: false
  error?: string
}

type IpcResult<T = unknown> = OkResult<T> | ErrResult

interface EngineStartConfig {
  apiKey: string
  model?: string
  baseURL?: string
  systemPrompt?: string
  appType: AppKind
}

/**
 * Home route. Renders the engine status + start/stop control + recent
 * activity log.
 *
 * Phase 5 PR2 migration:
 *  - `engine:start` → `useMutation` (pending state drives button disable;
 *    success/error route through toast + engine store).
 *  - `engine:stop` → `useMutation` (best-effort; failure still flips UI
 *    back to idle so the user can retry).
 *  - The `logs` ring buffer remains a local `useState` rather than a
 *    cache-as-state slot. Rationale: it's a push-only stream with no
 *    corresponding IPC `read` channel — moving it into the cache would
 *    just be `useState` in disguise. ControlPage is also the only
 *    consumer; no cross-page coordination needed. (See ADR-0013
 *    migration outcome §"State-mgmt-via-cache vs page-local useState".)
 *  - Engine `status` continues to flow through the global engine store,
 *    fed by `useEngineSubscription` and the mutation success handlers
 *    here. The store is the single source of truth for the coarse
 *    running/idle/error indicator; the rich `engine:lifecycle` snapshot
 *    lives in the react-query cache (DiagnosticsPanel).
 *
 * Phase 5 PR4: visual surface migrated to Tailwind utilities + shadcn
 * primitives (`Button`, `Card`). The big start/stop button keeps its
 * pill-shape, gradient fill, and accent-glow shadow via custom Tailwind
 * arbitrary-value classes so visual fidelity matches the pre-PR4 look.
 */
export function ControlPage(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useEngineStore((s) => s.status)
  const setStatus = useEngineStore((s) => s.setStatus)
  const draft = useSettingsStore((s) => s.draft)
  const patchDraft = useSettingsStore((s) => s.setDraft)
  const pushToast = useToastStore((s) => s.push)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry['type'], content: string): void => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  // Auto-scroll the log container as new entries arrive.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  // Subscribe to engine:log push events. The engine subscription hook
  // mounted by AppLayout handles `engine:state`; this listener is local
  // because the *raw* log entries don't belong in the engine store (they're
  // a per-page stream, not global app state).
  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (...args) => {
      const data = args[0] as EngineLogPayload | undefined
      if (!data) return
      addLog(data.type as LogEntry['type'], data.content)
      if (data.type === 'error' && data.content.includes('引擎无法启动')) {
        useEngineStore.getState().setStatus('error')
      }
    })
    return cleanup
  }, [addLog])

  const startEngine = useMutation<IpcResult, Error, EngineStartConfig>({
    mutationFn: (config) => ipc.invoke<IpcResult>('engine:start', config),
    onSuccess: (result) => {
      if (result?.success) {
        setStatus('running')
        pushToast(t('toast.engineStarted'), 'success')
        queryClient.invalidateQueries({ queryKey: ['engine:lifecycle'] })
      } else {
        setStatus('error')
        pushToast((result as ErrResult)?.error || t('toast.startFailed'), 'error')
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('error')
      pushToast(message || t('toast.startFailed'), 'error')
    }
  })

  const stopEngine = useMutation<unknown, Error, void>({
    mutationFn: () => ipc.invoke('engine:stop'),
    onSettled: () => {
      // Stop is best-effort: even if the IPC layer is wedged, we want the
      // UI to flip back to idle so the user can retry.
      setStatus('idle')
      pushToast(t('toast.engineStopped'), 'success')
      queryClient.invalidateQueries({ queryKey: ['engine:lifecycle'] })
    }
  })

  const handleStart = useCallback((): void => {
    const apiKey = draft.apiKey ?? ''
    if (!apiKey) {
      pushToast(t('control.start.nokey'), 'error')
      return
    }
    startEngine.mutate({
      apiKey,
      model: draft.model || undefined,
      baseURL: draft.baseURL || undefined,
      systemPrompt: draft.systemPrompt || undefined,
      appType: draft.appType || 'weixin'
    })
  }, [draft, pushToast, startEngine, t])

  const handleStop = useCallback((): void => {
    stopEngine.mutate()
  }, [stopEngine])

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  const running = status === 'running'

  return (
    <div className="animate-fade-in space-y-3">
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-md border border-border bg-card/80 px-3.5 py-3 backdrop-blur-md transition-colors',
          status === 'running' &&
            'border-primary/15 bg-primary/[0.08] shadow-[0_0_20px_hsl(var(--primary)/0.05)]',
          status === 'error' && 'border-destructive/15 bg-destructive/[0.08]'
        )}
        data-testid="control-status"
      >
        <StatusDot status={status} />
        <span className="text-sm font-medium">{statusLabel}</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>应用类型</CardTitle>
        </CardHeader>
        <CardContent>
          <select
            className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-background/40 px-3 py-1 text-xs font-mono text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={draft.appType ?? 'weixin'}
            onChange={(e): void => patchDraft({ appType: e.target.value as AppKind })}
            aria-label="appType"
          >
            <option value="weixin">微信</option>
            <option value="wework">企业微信</option>
          </select>
        </CardContent>
      </Card>

      <div className="flex">
        {running ? (
          <button
            type="button"
            className="no-drag flex h-12 flex-1 items-center justify-center gap-2 rounded-full border border-destructive/20 bg-gradient-to-br from-destructive/20 to-destructive/15 px-7 text-[13px] font-semibold text-destructive shadow-[0_4px_24px_hsl(var(--destructive)/0.1),inset_0_1px_0_hsl(0_0%_100%/0.05)] backdrop-blur-md transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-destructive/35 hover:shadow-[0_8px_32px_hsl(var(--destructive)/0.15),inset_0_1px_0_hsl(0_0%_100%/0.08)] active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-[18px] [&_svg]:w-[18px]"
            onClick={handleStop}
            disabled={stopEngine.isPending}
            aria-label={t('control.stop')}
            data-testid="control-stop"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="no-drag flex h-12 flex-1 items-center justify-center gap-2 rounded-full border border-primary/30 bg-gradient-to-br from-primary to-[hsl(160_84%_31%)] px-7 text-[13px] font-semibold text-primary-foreground shadow-[0_4px_24px_hsl(var(--primary)/0.35),inset_0_1px_0_hsl(0_0%_100%/0.15)] backdrop-blur-md transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-[0_8px_32px_hsl(var(--primary)/0.35),0_0_60px_hsl(var(--primary)/0.15),inset_0_1px_0_hsl(0_0%_100%/0.2)] active:translate-y-0 active:shadow-[0_2px_12px_hsl(var(--primary)/0.35)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-[18px] [&_svg]:w-[18px]"
            onClick={handleStart}
            disabled={startEngine.isPending}
            aria-label={t('control.start')}
            data-testid="control-start"
          >
            <PlayIcon />
          </button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('control.log')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            ref={logRef}
            className="min-h-[160px] max-h-[360px] overflow-y-auto rounded-md border border-border bg-black/25 p-2.5 font-mono text-[11px] leading-7"
          >
            {logs.length === 0 ? (
              <div className="flex h-[160px] items-center justify-center font-sans text-xs text-muted-foreground">
                {t('control.log.empty')}
              </div>
            ) : (
              logs.map((entry, i) => (
                <div
                  key={i}
                  className="border-b border-white/[0.02] py-[3px] last:border-b-0"
                  data-testid="log-entry"
                >
                  <span className="mr-1.5 text-[10px] text-muted-foreground/80">{entry.time}</span>
                  <span
                    className={cn('mr-[5px] text-[10px] font-semibold', LOG_TYPE_COLOR[entry.type])}
                  >
                    {t(LOG_TYPE_KEY[entry.type])}
                  </span>
                  <span>{entry.content}</span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
