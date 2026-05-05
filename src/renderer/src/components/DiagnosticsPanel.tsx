import { useCallback, useEffect, useMemo, useRef, useState, JSX } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { t } from '../i18n'
import { ipc } from '../lib/ipc'
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

/**
 * Diagnostics view. Shows lifecycle snapshot + live logs + recent
 * transitions, all driven by IPC channels established in Phase 1
 * (`engine:lifecycle`, `logs:recent`, `engine:log-record`, `engine:state`).
 *
 * As of Phase 5 PR1 the `logs:recent` ring-buffer pull is served by
 * `useQuery` (with a 1.5s `refetchInterval` as belt-and-suspenders for the
 * push-channel feed). Live `engine:log-record` events route into the
 * react-query cache via `setQueryData` so a single source of truth holds
 * the rendered list. Lifecycle + transitions remain in local state for
 * PR1; they migrate in PR2.
 */
export function DiagnosticsPanel({ onToast }: DiagnosticsPanelProps): JSX.Element {
  const queryClient = useQueryClient()
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot | null>(null)
  const [transitions, setTransitions] = useState<LifecycleEvent[]>([])
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [phaseFilter, setPhaseFilter] = useState<string>('all')
  const [isExporting, setIsExporting] = useState<boolean>(false)

  const logStreamRef = useRef<HTMLDivElement>(null)

  // ── Logs (react-query) ───────────────────────────────────────────────
  // Polling every 1.5s gives a backstop in case a push event is missed
  // (e.g. main process restart while the renderer stays open). The 5-second
  // staleTime in the global QueryClient is deliberately overridden to 0
  // here so the polling actually round-trips.
  const { data: logs = [] } = useQuery<LogRecord[]>({
    queryKey: LOGS_QUERY_KEY,
    queryFn: async () => {
      const result = await ipc.invoke<LogRecord[] | undefined>('logs:recent', LOGS_RECENT_LIMIT)
      return Array.isArray(result) ? result : []
    },
    refetchInterval: 1500,
    staleTime: 0
  })

  // ── One-shot lifecycle backfill ──────────────────────────────────────
  // Lifecycle stays in local state for PR1; PR2 moves it onto useQuery as
  // well. We backfill once and let the engine:state push subscriber take
  // over from there.
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const lifecycle = await ipc.invoke<LifecycleSnapshot | null>('engine:lifecycle')
        if (cancelled) return
        if (lifecycle) setSnapshot(lifecycle)
      } catch {
        // Defensive: a missing handler shouldn't crash the page.
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [])

  // ── Live log records → react-query cache ─────────────────────────────
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

  // ── Live lifecycle transitions ───────────────────────────────────────
  useEffect(() => {
    const cleanup = window.electron?.on('engine:state', (...args) => {
      const payload = args[0] as LifecycleStatePayload | undefined
      if (!payload) return
      setSnapshot(payload.snapshot)
      setTransitions((prev) => {
        const next = prev.length >= MAX_TRANSITIONS ? prev.slice(-MAX_TRANSITIONS + 1) : prev
        return [...next, payload.event]
      })
    })
    return cleanup
  }, [])

  // Auto-scroll the log container to the bottom when new records land.
  // Using `scrollTop = scrollHeight` instead of `scrollIntoView` keeps this
  // jsdom-friendly (jsdom has no layout engine and stubs `scrollIntoView`
  // off entirely).
  useEffect(() => {
    const el = logStreamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // Phase options derived from records — keeps the dropdown honest as new
  // modules emit logs (e.g. once Phase 3 adds `policy.*`).
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
    // Mirrors the IPC button's "<phrase>: <destination>" pattern so both
    // local-Blob and main-process zip exports read consistently.
    onToast?.(`${t('diag.export.success')}: ${filename}`, 'success')
  }, [logs, snapshot, transitions, onToast])

  // Triggers the main-side `diag:export` handler (Track A) which writes a zip
  // to disk containing logs + config + state snapshot. The renderer never
  // touches the filesystem; we just surface the resulting path/error via toast.
  const handleIpcExport = useCallback(async (): Promise<void> => {
    if (isExporting) return
    setIsExporting(true)
    try {
      const result = await ipc.invoke<
        { success: true; path: string; sizeBytes: number } | { success: false; error: string }
      >('diag:export', { includeLogs: true, daysBack: 14 })
      if (result?.success === true) {
        onToast?.(`${t('diag.export.success')}: ${result.path}`, 'success')
      } else {
        const message =
          result && result.success === false ? (result.error ?? 'unknown error') : 'unknown error'
        onToast?.(`${t('diag.export.failed')}: ${message}`, 'error')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      onToast?.(`${t('diag.export.failed')}: ${message}`, 'error')
    } finally {
      setIsExporting(false)
    }
  }, [isExporting, onToast])

  return (
    <div className="slide-up">
      <div className="card diag-card">
        <div className="card-title">{t('diag.lifecycle.title')}</div>
        <LifecycleCard snapshot={snapshot} />
      </div>

      <div className="card diag-card">
        <div className="card-title diag-card-title-row">
          <span>{t('diag.logs.title')}</span>
          <div className="diag-filters">
            <select
              className="diag-filter"
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
              className="diag-filter"
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
        <div className="diag-log-stream" data-testid="diag-log-stream" ref={logStreamRef}>
          {filtered.length === 0 ? (
            <div className="message-log-empty">{t('diag.logs.empty')}</div>
          ) : (
            filtered.map((r, i) => <LogRow key={`${r.ts}-${i}`} record={r} />)
          )}
        </div>
      </div>

      <div className="card diag-card">
        <div className="card-title">{t('diag.transitions.title')}</div>
        {transitions.length === 0 ? (
          <div className="message-log-empty">{t('diag.transitions.empty')}</div>
        ) : (
          <ul className="diag-transitions">
            {transitions
              .slice()
              .reverse()
              .map((evt, i) => (
                <li className="diag-transition" key={`${evt.at}-${i}`}>
                  <span className="diag-transition-time">{shortTime(evt.at)}</span>
                  <span className={`diag-state-pill ${evt.from}`}>{evt.from}</span>
                  <span className="diag-transition-arrow">→</span>
                  <span className={`diag-state-pill ${evt.to}`}>{evt.to}</span>
                  {evt.reason ? <span className="diag-transition-reason">{evt.reason}</span> : null}
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="form-actions diag-export-actions">
        <button
          className="btn btn-secondary diag-export-btn-ipc"
          onClick={handleIpcExport}
          disabled={isExporting}
          style={{ flex: 1 }}
          data-testid="diag-export-ipc-btn"
          title={t('diag.export.aria')}
        >
          <DownloadIcon />
          {isExporting ? t('diag.export.exporting') : t('diag.export.label')}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleExport}
          style={{ flex: 1 }}
          data-testid="diag-export-btn"
        >
          {t('diag.export')}
        </button>
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

// ── Sub-components ─────────────────────────────────────────────────────────

function LifecycleCard({ snapshot }: { snapshot: LifecycleSnapshot | null }): JSX.Element {
  if (!snapshot) {
    return (
      <div className="diag-lifecycle-empty">
        <span className={`diag-state-pill idle`}>idle</span>
        <span style={{ marginLeft: 8, opacity: 0.7 }}>—</span>
      </div>
    )
  }
  return (
    <div className="diag-lifecycle-grid">
      <div className="diag-row">
        <span className="diag-label">{t('diag.lifecycle.state')}</span>
        <span className={`diag-state-pill ${snapshot.state}`}>{snapshot.state}</span>
      </div>
      <div className="diag-row">
        <span className="diag-label">{t('diag.lifecycle.enteredAt')}</span>
        <span className="diag-value">{shortTime(snapshot.enteredAt)}</span>
      </div>
      <div className="diag-row">
        <span className="diag-label">{t('diag.lifecycle.restartBudget')}</span>
        <span className="diag-value">
          {snapshot.restartBudget.used}/{snapshot.restartBudget.max}
          <span className="diag-subvalue">
            ({t('diag.lifecycle.windowEndsAt')} {shortTime(snapshot.restartBudget.windowEndsAt)})
          </span>
        </span>
      </div>
      {snapshot.lastError ? (
        <div className="diag-row">
          <span className="diag-label">{t('diag.lifecycle.lastError')}</span>
          <span className="diag-value diag-error-msg">
            {snapshot.lastError.name}: {snapshot.lastError.message}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function LogRow({ record }: { record: LogRecord }): JSX.Element {
  return (
    <div className={`diag-log-row diag-log-${record.level}`}>
      <span className="diag-log-time">{shortTime(record.ts)}</span>
      <span className={`diag-log-level diag-log-${record.level}`}>
        {record.level.toUpperCase()}
      </span>
      <span className="diag-log-phase">{record.phase}</span>
      <span className="diag-log-msg">
        {record.msg}
        {record.err ? (
          <span className="diag-log-err">
            {' — '}
            {record.err.name}: {record.err.message}
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortTime(iso: string): string {
  // Render ISO timestamps as HH:MM:SS so the stream is dense; fall back to
  // the raw string if parsing fails (defensive — the logger always emits
  // ISO-8601, but a future sink could yield a different shape).
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
