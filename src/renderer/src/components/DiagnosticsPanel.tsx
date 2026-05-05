import { useCallback, useEffect, useMemo, useRef, useState, JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import type {
  LifecycleEvent,
  LifecycleSnapshot,
  LifecycleStatePayload,
  LogLevel,
  LogRecord
} from '../types'

const MAX_LOG_RECORDS = 500
const MAX_TRANSITIONS = 30
const LOGS_RECENT_LIMIT = 200
const LOGS_QUERY_KEY = ['logs:recent', LOGS_RECENT_LIMIT] as const
const LIFECYCLE_QUERY_KEY = ['engine:lifecycle'] as const

interface DiagExportOk {
  success: true
  path: string
  sizeBytes: number
}
interface DiagExportErr {
  success: false
  error: string
}
type DiagExportResult = DiagExportOk | DiagExportErr

const LEVEL_OPTIONS: ReadonlyArray<LogLevel | 'all'> = [
  'all',
  'trace',
  'debug',
  'info',
  'warn',
  'error'
]

interface DiagnosticsPanelProps {
  /** Used by tests to assert toast invocations from the export button. */
  onToast?: (msg: string, type: 'success' | 'error') => void
}

// Tailwind class fragments for the colored "state pill" used in the
// lifecycle card and transition rows. Centralized so the two locations
// can't drift visually.
const STATE_PILL_BASE =
  'inline-block rounded-full border bg-card px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] font-mono'
const STATE_PILL_VARIANTS: Record<string, string> = {
  idle: 'border-border text-muted-foreground',
  stopped: 'border-border text-muted-foreground',
  running: 'border-primary/20 bg-primary/[0.08] text-primary',
  paused: 'border-warning/20 bg-warning/[0.08] text-warning',
  crashed: 'border-destructive/20 bg-destructive/[0.08] text-destructive',
  recovering: 'border-[hsl(213_94%_68%/0.2)] bg-[hsl(213_94%_68%/0.08)] text-[hsl(213_94%_68%)]'
}

function statePill(state: string): string {
  return cn(STATE_PILL_BASE, STATE_PILL_VARIANTS[state] ?? STATE_PILL_VARIANTS.idle)
}

const LOG_ROW_LEVEL_COLOR: Record<LogLevel, string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-warning',
  error: 'text-destructive'
}

const LOG_LEVEL_BADGE_COLOR: Record<LogLevel, string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-primary',
  warn: 'text-warning',
  error: 'text-destructive'
}

/**
 * Diagnostics view. Lifecycle snapshot + live log stream + recent
 * transitions, all driven by IPC channels established in Phase 1
 * (`engine:lifecycle`, `logs:recent`, `engine:log-record`, `engine:state`).
 *
 * Phase 5 PR2: every IPC call is now `useQuery` / `useMutation`; push
 * channels (`engine:state`, `engine:log-record`) route into the same
 * cache keys via `setQueryData` for a single source of truth.
 *
 * Phase 5 PR4: replaced `.card`/`.diag-*`/`.btn` hand-written classes
 * with Tailwind utilities + shadcn primitives (`Card`, `Button`). The
 * coloured state pill is derived from a single Tailwind class map
 * (`STATE_PILL_VARIANTS`) so the lifecycle card and the transition rows
 * cannot drift.
 */
export function DiagnosticsPanel({ onToast }: DiagnosticsPanelProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [transitions, setTransitions] = useState<LifecycleEvent[]>([])
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [phaseFilter, setPhaseFilter] = useState<string>('all')

  const logStreamRef = useRef<HTMLDivElement>(null)

  const { data: logs = [] } = useQuery<LogRecord[]>({
    queryKey: LOGS_QUERY_KEY,
    queryFn: async () => {
      const result = await ipc.invoke<LogRecord[] | undefined>('logs:recent', LOGS_RECENT_LIMIT)
      return Array.isArray(result) ? result : []
    },
    refetchInterval: 1500,
    staleTime: 0
  })

  const { data: snapshot = null } = useQuery<LifecycleSnapshot | null>({
    queryKey: LIFECYCLE_QUERY_KEY,
    queryFn: async () => {
      try {
        const lifecycle = await ipc.invoke<LifecycleSnapshot | null>('engine:lifecycle')
        return lifecycle ?? null
      } catch {
        return null
      }
    },
    staleTime: Infinity
  })

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log-record', (...args) => {
      const record = args[0] as LogRecord | undefined
      if (!record) return
      queryClient.setQueryData<LogRecord[]>(LOGS_QUERY_KEY, (prev) => {
        const base = prev ?? []
        const next = base.length >= MAX_LOG_RECORDS ? base.slice(-MAX_LOG_RECORDS + 1) : base
        return [...next, record]
      })
    })
    return cleanup
  }, [queryClient])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (...args) => {
      const payload = args[0] as LifecycleStatePayload | undefined
      if (!payload) return
      queryClient.setQueryData<LifecycleSnapshot | null>(LIFECYCLE_QUERY_KEY, payload.snapshot)
      setTransitions((prev) => {
        const next = prev.length >= MAX_TRANSITIONS ? prev.slice(-MAX_TRANSITIONS + 1) : prev
        return [...next, payload.event]
      })
    })
    return cleanup
  }, [queryClient])

  useEffect(() => {
    const el = logStreamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const phaseOptions = useMemo<string[]>(() => {
    const set = new Set<string>()
    for (const r of logs) set.add(r.phase)
    return ['all', ...Array.from(set).sort()]
  }, [logs])

  const filtered = useMemo(() => {
    return logs.filter((r) => {
      if (levelFilter !== 'all' && r.level !== levelFilter) return false
      if (phaseFilter !== 'all' && r.phase !== phaseFilter) return false
      return true
    })
  }, [logs, levelFilter, phaseFilter])

  const handleExport = useCallback(() => {
    const bundle = {
      exportedAt: new Date().toISOString(),
      app: 'sightflow-desktop-agent',
      lifecycle: snapshot,
      transitions,
      logs
    }
    const filename = `sightflow-diagnostics-${Date.now()}.json`
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    onToast?.(`${t('diag.export.success')}: ${filename}`, 'success')
  }, [logs, snapshot, transitions, onToast, t])

  const diagExport = useMutation<
    DiagExportResult,
    Error,
    { includeLogs: boolean; daysBack: number }
  >({
    mutationFn: (vars) => ipc.invoke<DiagExportResult>('diag:export', vars),
    onSuccess: (result) => {
      if (result?.success === true) {
        onToast?.(`${t('diag.export.success')}: ${result.path}`, 'success')
      } else {
        const message =
          result?.success === false ? (result.error ?? 'unknown error') : 'unknown error'
        onToast?.(`${t('diag.export.failed')}: ${message}`, 'error')
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'unknown error'
      onToast?.(`${t('diag.export.failed')}: ${message}`, 'error')
    }
  })
  const isExporting = diagExport.isPending
  const handleIpcExport = useCallback((): void => {
    if (diagExport.isPending) return
    diagExport.mutate({ includeLogs: true, daysBack: 14 })
  }, [diagExport])

  const filterSelectClass =
    'h-7 cursor-pointer rounded-md border border-input bg-background/40 px-2 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring'

  return (
    <div className="animate-slide-up space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('diag.lifecycle.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LifecycleCard snapshot={snapshot} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{t('diag.logs.title')}</CardTitle>
            <div className="flex gap-1.5 normal-case tracking-normal">
              <select
                className={filterSelectClass}
                value={levelFilter}
                onChange={(e): void => setLevelFilter(e.target.value as LogLevel | 'all')}
                aria-label={t('diag.logs.filterLevel')}
              >
                {LEVEL_OPTIONS.map((lvl) => (
                  <option key={lvl} value={lvl}>
                    {lvl === 'all' ? t('diag.logs.filterAll') : lvl}
                  </option>
                ))}
              </select>
              <select
                className={filterSelectClass}
                value={phaseFilter}
                onChange={(e): void => setPhaseFilter(e.target.value)}
                aria-label={t('diag.logs.filterPhase')}
              >
                {phaseOptions.map((p) => (
                  <option key={p} value={p}>
                    {p === 'all' ? t('diag.logs.filterAll') : p}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div
            ref={logStreamRef}
            data-testid="diag-log-stream"
            className="max-h-[320px] overflow-y-auto rounded-md border border-border bg-black/25 p-2 font-mono text-[11px] leading-[1.55]"
          >
            {filtered.length === 0 ? (
              <div className="flex h-[160px] items-center justify-center font-sans text-xs text-muted-foreground">
                {t('diag.logs.empty')}
              </div>
            ) : (
              filtered.map((r, i) => <LogRow key={`${r.ts}-${i}`} record={r} />)
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('diag.transitions.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {transitions.length === 0 ? (
            <div className="flex h-[160px] items-center justify-center font-sans text-xs text-muted-foreground">
              {t('diag.transitions.empty')}
            </div>
          ) : (
            <ul className="m-0 flex max-h-[200px] list-none flex-col gap-1.5 overflow-y-auto p-0">
              {transitions
                .slice()
                .reverse()
                .map((evt, i) => (
                  <li
                    className="flex items-center gap-2 font-mono text-[11px]"
                    data-testid="diag-transition-row"
                    key={`${evt.at}-${i}`}
                  >
                    <span className="min-w-[64px] text-muted-foreground">{shortTime(evt.at)}</span>
                    <span className={statePill(evt.from)} data-testid="diag-state-pill">
                      {evt.from}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className={statePill(evt.to)} data-testid="diag-state-pill">
                      {evt.to}
                    </span>
                    {evt.reason ? (
                      <span className="italic text-muted-foreground">{evt.reason}</span>
                    ) : null}
                  </li>
                ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={handleIpcExport}
          disabled={isExporting}
          data-testid="diag-export-ipc-btn"
          title={t('diag.export.aria')}
        >
          <DownloadIcon />
          {isExporting ? t('diag.export.exporting') : t('diag.export.label')}
        </Button>
        <Button className="flex-1" onClick={handleExport} data-testid="diag-export-btn">
          {t('diag.export')}
        </Button>
      </div>
    </div>
  )
}

function DownloadIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function LifecycleCard({ snapshot }: { snapshot: LifecycleSnapshot | null }): JSX.Element {
  const { t } = useTranslation()
  if (!snapshot) {
    return (
      <div className="flex items-center gap-2">
        <span className={statePill('idle')}>idle</span>
        <span className="text-muted-foreground/70">—</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <DiagRow label={t('diag.lifecycle.state')}>
        <span className={statePill(snapshot.state)}>{snapshot.state}</span>
      </DiagRow>
      <DiagRow label={t('diag.lifecycle.enteredAt')}>
        <span className="font-mono text-xs text-foreground">{shortTime(snapshot.enteredAt)}</span>
      </DiagRow>
      <DiagRow label={t('diag.lifecycle.restartBudget')}>
        <span className="font-mono text-xs text-foreground">
          {snapshot.restartBudget.used}/{snapshot.restartBudget.max}
          <span className="ml-1.5 text-[11px] text-muted-foreground/80">
            ({t('diag.lifecycle.windowEndsAt')} {shortTime(snapshot.restartBudget.windowEndsAt)})
          </span>
        </span>
      </DiagRow>
      {snapshot.lastError ? (
        <DiagRow label={t('diag.lifecycle.lastError')}>
          <span className="font-mono text-xs text-destructive">
            {snapshot.lastError.name}: {snapshot.lastError.message}
          </span>
        </DiagRow>
      ) : null}
    </div>
  )
}

function DiagRow({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="min-w-[76px] text-[11px] uppercase tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function LogRow({ record }: { record: LogRecord }): JSX.Element {
  return (
    <div
      className={cn(
        'grid grid-cols-[64px_56px_100px_1fr] gap-2 break-words py-0.5',
        LOG_ROW_LEVEL_COLOR[record.level]
      )}
    >
      <span className="text-muted-foreground">{shortTime(record.ts)}</span>
      <span className={cn('font-semibold tracking-[0.04em]', LOG_LEVEL_BADGE_COLOR[record.level])}>
        {record.level.toUpperCase()}
      </span>
      <span className="text-muted-foreground">{record.phase}</span>
      <span>
        {record.msg}
        {record.err ? (
          <span className="text-destructive">
            {' — '}
            {record.err.name}: {record.err.message}
          </span>
        ) : null}
      </span>
    </div>
  )
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
