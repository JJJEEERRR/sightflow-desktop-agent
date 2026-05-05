import { JSX, useCallback, useEffect, useRef, useState } from 'react'
import { t, type TranslationKey } from '../i18n'
import { ipc } from '../lib/ipc'
import { useEngineStore } from '../stores/engine'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'
import { PlayIcon, StopIcon } from '../components/icons'
import type { AppKind } from '../types'

interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
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

/**
 * Home route. Renders the engine status + start/stop control + recent
 * activity log. Status flows through the global engine store; the log
 * stream remains in local state for PR1 (it migrates to react-query +
 * `logs:recent` in PR2 — see ADR-0013).
 */
export function ControlPage(): JSX.Element {
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

  const handleStart = useCallback(async () => {
    const apiKey = draft.apiKey ?? ''
    if (!apiKey) {
      pushToast(t('control.start.nokey'), 'error')
      return
    }
    const config = {
      apiKey,
      model: draft.model || undefined,
      baseURL: draft.baseURL || undefined,
      systemPrompt: draft.systemPrompt || undefined,
      appType: draft.appType || 'weixin'
    }
    try {
      const result = await ipc.invoke<IpcResult>('engine:start', config)
      if (result?.success) {
        setStatus('running')
        pushToast(t('toast.engineStarted'), 'success')
      } else {
        setStatus('error')
        pushToast((result as ErrResult)?.error || t('toast.startFailed'), 'error')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus('error')
      pushToast(message || t('toast.startFailed'), 'error')
    }
  }, [draft, pushToast, setStatus])

  const handleStop = useCallback(async () => {
    try {
      await ipc.invoke('engine:stop')
    } catch {
      // Stop is best-effort: even if the IPC layer is wedged, we want the
      // UI to flip back to idle so the user can retry.
    }
    setStatus('idle')
    pushToast(t('toast.engineStopped'), 'success')
  }, [pushToast, setStatus])

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  const running = status === 'running'

  return (
    <div className="fade-in">
      <div className={`status-indicator ${status}`}>
        <div className={`status-dot ${status}`} />
        <span className="status-text">{statusLabel}</span>
      </div>

      <div className="card">
        <div className="card-title">应用类型</div>
        <select
          className="form-input"
          value={draft.appType ?? 'weixin'}
          onChange={(e): void => patchDraft({ appType: e.target.value as AppKind })}
          aria-label="appType"
        >
          <option value="weixin">微信</option>
          <option value="wework">企业微信</option>
        </select>
      </div>

      <div className="form-actions" style={{ marginBottom: 12 }}>
        {running ? (
          <button
            className="bottom-btn bottom-btn-stop"
            onClick={handleStop}
            style={{ flex: 1 }}
            aria-label={t('control.stop')}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="bottom-btn bottom-btn-start bottom-btn-play"
            onClick={handleStart}
            style={{ flex: 1 }}
            aria-label={t('control.start')}
          >
            <PlayIcon />
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-title">{t('control.log')}</div>
        <div className="message-log" ref={logRef}>
          {logs.length === 0 ? (
            <div className="message-log-empty">{t('control.log.empty')}</div>
          ) : (
            logs.map((entry, i) => (
              <div className="log-entry" key={i}>
                <span className="log-time">{entry.time}</span>
                <span className={`log-type ${entry.type}`}>
                  {t(`control.log.${entry.type}` as TranslationKey)}
                </span>
                <span>{entry.content}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
