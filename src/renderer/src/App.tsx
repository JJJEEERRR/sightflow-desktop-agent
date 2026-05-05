import { useState, useCallback, useRef, useEffect, JSX } from 'react'
import { t, type TranslationKey } from './i18n'
import logoUrl from './assets/logo.png'
import { DiagnosticsPanel } from './components/DiagnosticsPanel'
import { AntiDetectionSettings } from './components/AntiDetectionSettings'
import './index.css'

// ─── Types ───
interface LogEntry {
  time: string
  type: 'thinking' | 'reply' | 'skip' | 'error'
  content: string
}

type EngineStatus = 'idle' | 'running' | 'error'
type View = 'control' | 'settings' | 'diagnostics' | 'antiDetection'
type AppKind = 'weixin' | 'wework'

interface AppSettings {
  apiKey?: string
  model?: string
  baseURL?: string
  systemPrompt?: string
  appType?: AppKind
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

interface EngineLogPayload {
  type: string
  content: string
}

// ─── SVG Icons ───
const PlayIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5.14v14l11-7-11-7z" />
  </svg>
)

const StopIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

const GearIcon = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const BackIcon = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
)

const ActivityIcon = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
)

// ─── App ───
function App(): JSX.Element {
  const [view, setView] = useState<View>('control')
  const [status, setStatus] = useState<EngineStatus>('idle')

  return (
    <div className="app">
      <header className="app-header">
        {view !== 'control' ? (
          <button
            className="bottom-btn bottom-btn-settings"
            onClick={(): void => setView('control')}
            aria-label="back"
            style={{ width: 32, height: 32, marginRight: 4 }}
          >
            <BackIcon />
          </button>
        ) : null}
        <img src={logoUrl} alt="SightFlow" className="app-logo" />
        {view === 'diagnostics' ? (
          <span className="app-header-title">{t('diag.title')}</span>
        ) : view === 'antiDetection' ? (
          <span className="app-header-title">{t('policy.title')}</span>
        ) : null}
      </header>

      <div className="app-content">
        {view === 'control' ? (
          <ControlPanel status={status} setStatus={setStatus} />
        ) : view === 'settings' ? (
          <SettingsPanel onNavigatePolicy={(): void => setView('antiDetection')} />
        ) : view === 'antiDetection' ? (
          <AntiDetectionSettings
            onToast={showToast}
            onNavigateDiagnostics={(): void => setView('diagnostics')}
          />
        ) : (
          <DiagnosticsPanel onToast={showToast} />
        )}
      </div>

      {view === 'control' && (
        <BottomBar
          status={status}
          setStatus={setStatus}
          onSettings={(): void => setView('settings')}
          onDiagnostics={(): void => setView('diagnostics')}
        />
      )}

      <Toast />
    </div>
  )
}

// ─── Control Panel ───
function ControlPanel({
  status,
  setStatus
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
}): JSX.Element {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((type: LogEntry['type'], content: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    setLogs((prev) => [...prev.slice(-99), { time, type, content }])
  }, [])

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    const cleanup = window.electron?.on('engine:log', (...args) => {
      const data = args[0] as EngineLogPayload | undefined
      if (!data) return
      addLog(data.type as LogEntry['type'], data.content)

      if (data.type === 'error' && data.content.includes('引擎无法启动')) {
        setStatus('error')
      }
    })
    return cleanup
  }, [addLog, setStatus])

  const statusLabel =
    status === 'running'
      ? t('status.running')
      : status === 'error'
        ? t('status.error')
        : t('status.idle')

  return (
    <div className="fade-in">
      <div className={`status-indicator ${status}`}>
        <div className={`status-dot ${status}`} />
        <span className="status-text">{statusLabel}</span>
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

// ─── Bottom Bar ───
function BottomBar({
  status,
  setStatus,
  onSettings,
  onDiagnostics
}: {
  status: EngineStatus
  setStatus: (s: EngineStatus) => void
  onSettings: () => void
  onDiagnostics: () => void
}): JSX.Element {
  const handleStart = useCallback(async () => {
    const settings = await window.electron?.invoke<AppSettings | undefined>('settings:getAll')
    const apiKey = settings?.apiKey || ''
    if (!apiKey) {
      showToast(t('control.start.nokey'), 'error')
      return
    }

    const config = {
      apiKey,
      model: settings?.model || undefined,
      baseURL: settings?.baseURL || undefined,
      systemPrompt: settings?.systemPrompt || undefined,
      appType: settings?.appType || 'weixin'
    }

    const result = await window.electron?.invoke<IpcResult>('engine:start', config)
    if (result?.success) {
      setStatus('running')
      showToast(t('toast.engineStarted'), 'success')
    } else {
      setStatus('error')
      showToast(result?.error || t('toast.startFailed'), 'error')
    }
  }, [setStatus])

  const handleStop = useCallback(async () => {
    await window.electron?.invoke('engine:stop')
    setStatus('idle')
    showToast(t('toast.engineStopped'), 'success')
  }, [setStatus])

  const running = status === 'running'

  return (
    <div className="bottom-bar">
      {running ? (
        <button className="bottom-btn bottom-btn-stop" onClick={handleStop}>
          <StopIcon />
        </button>
      ) : (
        <button className="bottom-btn bottom-btn-start" onClick={handleStart}>
          <PlayIcon />
        </button>
      )}
      <button
        className="bottom-btn bottom-btn-settings"
        onClick={onDiagnostics}
        aria-label={t('diag.title')}
      >
        <ActivityIcon />
      </button>
      <button className="bottom-btn bottom-btn-settings" onClick={onSettings}>
        <GearIcon />
      </button>
    </div>
  )
}

// ─── Settings Panel ───
function SettingsPanel({ onNavigatePolicy }: { onNavigatePolicy: () => void }): JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('doubao-seed-2-0-lite-260215')
  const [baseURL, setBaseURL] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [appType, setAppType] = useState<AppKind>('weixin')
  const [testing, setTesting] = useState(false)
  const [, setLoaded] = useState(false)

  useEffect(() => {
    window.electron?.invoke<AppSettings | undefined>('settings:getAll').then((settings) => {
      if (settings) {
        setApiKey(settings.apiKey || '')
        setModel('doubao-seed-2-0-lite-260215')
        setBaseURL(settings.baseURL || '')
        setSystemPrompt(settings.systemPrompt || '')
        setAppType(settings.appType || 'weixin')
      }
      setLoaded(true)
    })
  }, [])

  const handleSave = useCallback(async () => {
    await window.electron?.invoke('settings:set', {
      apiKey,
      model,
      baseURL,
      systemPrompt,
      appType
    })

    window.electron?.invoke('engine:updateConfig', {
      apiKey: apiKey || undefined,
      model: model || undefined,
      baseURL: baseURL || undefined,
      systemPrompt: systemPrompt || undefined,
      appType
    })

    showToast(t('settings.saved'), 'success')
  }, [apiKey, model, baseURL, systemPrompt, appType])

  const handleTestConnection = useCallback(async () => {
    if (!apiKey) return
    setTesting(true)
    try {
      const result = await window.electron?.invoke<IpcResult>('engine:testConnection', {
        apiKey,
        model: model || undefined,
        baseURL: baseURL || undefined
      })
      if (result?.success) {
        showToast(t('settings.testConnection.success'), 'success')
      } else {
        showToast(`${t('settings.testConnection.fail')}: ${result?.error || ''}`, 'error')
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      showToast(`${t('settings.testConnection.fail')}: ${message}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [apiKey, model, baseURL])

  return (
    <div className="slide-up">
      <div className="card">
        <div className="card-title">{t('settings.ai')}</div>

        <div className="form-group">
          <label className="form-label">应用类型</label>
          <select
            className="form-input"
            value={appType}
            onChange={(e) => setAppType(e.target.value as AppKind)}
          >
            <option value="weixin">微信</option>
            <option value="wework">企业微信</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.apiKey')}</label>
          <input
            className="form-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('settings.apiKey.placeholder')}
            autoComplete="off"
          />
          <div className="form-hint">{t('settings.apiKey.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.baseURL')}</label>
          <input
            className="form-input"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder={t('settings.baseURL.placeholder')}
          />
          <div className="form-hint">{t('settings.baseURL.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.model')}</label>
          <input
            className="form-input"
            value={model}
            disabled
            placeholder={t('settings.model.placeholder')}
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.systemPrompt')}</label>
          <textarea
            className="form-input form-textarea"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('settings.systemPrompt.placeholder')}
            rows={6}
          />
        </div>

        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={handleTestConnection}
            style={{ flex: 1 }}
            disabled={!apiKey || testing}
          >
            {testing ? t('settings.testConnection.testing') : t('settings.testConnection')}
          </button>
          <button className="btn btn-primary" onClick={handleSave} style={{ flex: 1 }}>
            {t('settings.save')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">{t('policy.title')}</div>
        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={onNavigatePolicy}
            style={{ flex: 1 }}
            data-testid="open-anti-detection"
          >
            {t('policy.openSettings')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Toast ───
let _showToast: ((msg: string, type: 'success' | 'error') => void) | null = null

function showToast(msg: string, type: 'success' | 'error'): void {
  _showToast?.(msg, type)
}

function Toast(): JSX.Element {
  const [visible, setVisible] = useState(false)
  const [message, setMessage] = useState('')
  const [type, setType] = useState<'success' | 'error'>('success')
  const timerRef = useRef<number | undefined>(undefined)

  const handleShow = useCallback((msg: string, t: 'success' | 'error') => {
    setMessage(msg)
    setType(t)
    setVisible(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setVisible(false), 2500)
  }, [])

  // Wire up the module-level imperative entrypoint so callers outside the
  // component tree (showToast helper) can trigger a toast. We bind in an effect
  // (not during render) and clean up on unmount, so React purity rules hold.
  useEffect(() => {
    _showToast = handleShow
    return () => {
      if (_showToast === handleShow) _showToast = null
    }
  }, [handleShow])

  return <div className={`toast ${type} ${visible ? 'show' : ''}`}>{message}</div>
}

export default App
