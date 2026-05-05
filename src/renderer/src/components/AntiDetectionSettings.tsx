import { useCallback, useEffect, useMemo, useRef, useState, JSX } from 'react'
import { t } from '../i18n'

// UI mirror of src/core/policy/config.ts. Source of truth lives in core;
// renderer cannot import zod-laden modules.
interface HumanizerConfig {
  enabled: boolean
  preActionDelayMs: [number, number]
  postActionDelayMs: [number, number]
  clickJitterPx: number
  charsPerSecond: [number, number]
  punctuationPauseMs: [number, number]
  typoProbability: number
  longPauseProbability: number
  longPauseMs: [number, number]
  readDelayMs: [number, number]
}

interface RateLimiterConfig {
  enabled: boolean
  globalPerHour: number
  perContactPerDay: number
  minIntervalMs: number
  newContactCooldownMs: number
}

interface ScheduleConfig {
  enabled: boolean
  windows: Record<string, Array<[string, string]>>
  afkProbability: number
  afkDurationMs: [number, number]
}

interface CircuitBreakerConfig {
  enabled: boolean
  consecutiveAiFailures: number
  consecutiveRpaFailures: number
  duplicateReplyCount: number
  screenshotFreezeMs: number
  bannedKeywords: string[]
}

interface AntiDetectionConfig {
  humanizer: HumanizerConfig
  rateLimiter: RateLimiterConfig
  schedule: ScheduleConfig
  circuitBreaker: CircuitBreakerConfig
}

interface PolicySnapshot {
  config: AntiDetectionConfig
  rateLimiter: {
    hourly: { used: number; max: number; resetAt: number }
    perContact: Record<string, { used: number; max: number; resetAt: number }>
    lastSendAt: number
  }
  schedule: { awake: boolean; reason?: string; nextAwakeAt: string | null }
  circuitBreaker: {
    state: { tripped: false } | { tripped: true; reason: string; detail: string; at: number }
    consecutiveAiFailures: number
    consecutiveRpaFailures: number
  }
}

type SetResult = { success: true; config: AntiDetectionConfig } | { success: false; error: string }

interface AntiDetectionSettingsProps {
  /** Forwarded to the global toast helper. */
  onToast?: (msg: string, type: 'success' | 'error') => void
  /** Optional navigation callback wired from App for the breaker banner's
   *  "view diagnostics" affordance. */
  onNavigateDiagnostics?: () => void
}

// Hard-coded preset partials. Applied as a shallow merge over the relevant
// config blocks so the user can iterate from a known starting point without
// losing unrelated edits. "Balanced" snaps back to whatever the server
// returned on first load (which is, by definition, the schema defaults).
const CONSERVATIVE_PRESET = {
  rateLimiter: {
    globalPerHour: 15,
    perContactPerDay: 10,
    minIntervalMs: 12_000,
    newContactCooldownMs: 120_000
  },
  circuitBreaker: {
    consecutiveAiFailures: 3,
    consecutiveRpaFailures: 2
  }
} as const

const AGGRESSIVE_PRESET = {
  rateLimiter: {
    globalPerHour: 60,
    perContactPerDay: 40,
    minIntervalMs: 4_000,
    newContactCooldownMs: 30_000
  },
  circuitBreaker: {
    consecutiveAiFailures: 8,
    consecutiveRpaFailures: 5
  }
} as const

export function AntiDetectionSettings({
  onToast,
  onNavigateDiagnostics
}: AntiDetectionSettingsProps): JSX.Element {
  const [config, setConfig] = useState<AntiDetectionConfig | null>(null)
  const [snapshot, setSnapshot] = useState<PolicySnapshot | null>(null)
  const [windowsJson, setWindowsJson] = useState<string>('{}')
  const [windowsJsonError, setWindowsJsonError] = useState<string | null>(null)
  const [bannedKeywordsText, setBannedKeywordsText] = useState<string>('')
  const [saving, setSaving] = useState(false)
  // Captures the most recent server-supplied config so the "balanced" preset
  // and "reload" action can both rewind to the canonical defaults.
  const initialConfigRef = useRef<AntiDetectionConfig | null>(null)

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const snap = (await window.electron?.invoke<PolicySnapshot | null>('policy:snapshot')) ?? null
    setSnapshot(snap)
  }, [])

  const applyServerConfig = useCallback((cfg: AntiDetectionConfig): void => {
    setConfig(cfg)
    setWindowsJson(JSON.stringify(cfg.schedule.windows ?? {}, null, 2))
    setWindowsJsonError(null)
    setBannedKeywordsText((cfg.circuitBreaker.bannedKeywords ?? []).join('\n'))
    initialConfigRef.current = cfg
  }, [])

  // Backfill config + snapshot in parallel; subsequent edits are local until
  // the user clicks Save. Snapshot is allowed to be null (engine never started).
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      const [cfg, snap] = await Promise.all([
        window.electron?.invoke<AntiDetectionConfig>('policy:get'),
        window.electron?.invoke<PolicySnapshot | null>('policy:snapshot')
      ])
      if (cancelled) return
      if (cfg) applyServerConfig(cfg)
      setSnapshot(snap ?? null)
    })()
    return (): void => {
      cancelled = true
    }
  }, [applyServerConfig])

  // Cross-field validation. Save is blocked while any range is inverted or
  // the windows JSON is unparseable; the inline errors point the user at the
  // offending field.
  const rangeInvalid = useMemo(() => {
    if (!config) return false
    const ranges: Array<[number, number]> = [
      config.humanizer.preActionDelayMs,
      config.humanizer.postActionDelayMs,
      config.humanizer.charsPerSecond,
      config.humanizer.punctuationPauseMs,
      config.humanizer.longPauseMs,
      config.humanizer.readDelayMs,
      config.schedule.afkDurationMs
    ]
    return ranges.some(([a, b]) => a > b)
  }, [config])

  const canSave = !!config && !rangeInvalid && !windowsJsonError && !saving

  // ── Field updaters ───────────────────────────────────────────────────────
  const updateHumanizer = useCallback(
    <K extends keyof HumanizerConfig>(key: K, value: HumanizerConfig[K]): void => {
      setConfig((prev) =>
        prev ? { ...prev, humanizer: { ...prev.humanizer, [key]: value } } : prev
      )
    },
    []
  )
  const updateRateLimiter = useCallback(
    <K extends keyof RateLimiterConfig>(key: K, value: RateLimiterConfig[K]): void => {
      setConfig((prev) =>
        prev ? { ...prev, rateLimiter: { ...prev.rateLimiter, [key]: value } } : prev
      )
    },
    []
  )
  const updateSchedule = useCallback(
    <K extends keyof ScheduleConfig>(key: K, value: ScheduleConfig[K]): void => {
      setConfig((prev) => (prev ? { ...prev, schedule: { ...prev.schedule, [key]: value } } : prev))
    },
    []
  )
  const updateBreaker = useCallback(
    <K extends keyof CircuitBreakerConfig>(key: K, value: CircuitBreakerConfig[K]): void => {
      setConfig((prev) =>
        prev ? { ...prev, circuitBreaker: { ...prev.circuitBreaker, [key]: value } } : prev
      )
    },
    []
  )

  // ── Presets ──────────────────────────────────────────────────────────────
  const applyPresetConservative = useCallback((): void => {
    setConfig((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        rateLimiter: { ...prev.rateLimiter, ...CONSERVATIVE_PRESET.rateLimiter },
        circuitBreaker: { ...prev.circuitBreaker, ...CONSERVATIVE_PRESET.circuitBreaker }
      }
    })
  }, [])
  const applyPresetBalanced = useCallback((): void => {
    const initial = initialConfigRef.current
    if (initial) applyServerConfig(initial)
  }, [applyServerConfig])
  const applyPresetAggressive = useCallback((): void => {
    setConfig((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        rateLimiter: { ...prev.rateLimiter, ...AGGRESSIVE_PRESET.rateLimiter },
        circuitBreaker: { ...prev.circuitBreaker, ...AGGRESSIVE_PRESET.circuitBreaker }
      }
    })
  }, [])

  // ── Windows JSON / banned keywords textarea wiring ───────────────────────
  const handleWindowsJsonChange = useCallback(
    (next: string): void => {
      setWindowsJson(next)
      try {
        const parsed = JSON.parse(next) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setWindowsJsonError(t('policy.invalidWindowsJson'))
          return
        }
        setWindowsJsonError(null)
        updateSchedule('windows', parsed as Record<string, Array<[string, string]>>)
      } catch {
        setWindowsJsonError(t('policy.invalidWindowsJson'))
      }
    },
    [updateSchedule]
  )

  const handleBannedKeywordsChange = useCallback(
    (next: string): void => {
      setBannedKeywordsText(next)
      const list = next
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      updateBreaker('bannedKeywords', list)
    },
    [updateBreaker]
  )

  // ── Save / reload / breaker reset ────────────────────────────────────────
  const handleSave = useCallback(async (): Promise<void> => {
    if (!config || !canSave) return
    setSaving(true)
    try {
      const result = (await window.electron?.invoke<SetResult>('policy:set', config)) ?? undefined
      if (result?.success) {
        applyServerConfig(result.config)
        onToast?.(t('policy.saved'), 'success')
      } else {
        const err = result?.error ?? ''
        onToast?.(`${t('policy.saveFailed')}: ${err}`, 'error')
      }
    } finally {
      setSaving(false)
    }
  }, [config, canSave, applyServerConfig, onToast])

  const handleReload = useCallback((): void => {
    void (async (): Promise<void> => {
      const cfg = await window.electron?.invoke<AntiDetectionConfig>('policy:get')
      if (cfg) applyServerConfig(cfg)
    })()
  }, [applyServerConfig])

  const handleResetBreaker = useCallback(async (): Promise<void> => {
    await window.electron?.invoke('policy:resetBreaker')
    await refreshSnapshot()
    onToast?.(t('policy.resetBreakerDone'), 'success')
  }, [refreshSnapshot, onToast])

  if (!config) {
    return <div className="slide-up" data-testid="policy-loading" />
  }

  const breakerTripped = snapshot?.circuitBreaker.state.tripped === true
  const breakerReason =
    snapshot?.circuitBreaker.state.tripped === true ? snapshot.circuitBreaker.state.reason : ''

  return (
    <div className="slide-up">
      {breakerTripped ? (
        <div className="card policy-breaker-banner" data-testid="policy-breaker-banner">
          <div className="card-title policy-breaker-title">{t('policy.tripped')}</div>
          <div className="policy-breaker-reason">{breakerReason}</div>
          <div className="form-actions">
            <button
              className="btn btn-danger"
              onClick={handleResetBreaker}
              data-testid="policy-reset-breaker"
            >
              {t('policy.resetBreaker')}
            </button>
            {onNavigateDiagnostics ? (
              <button className="btn btn-secondary" onClick={onNavigateDiagnostics}>
                {t('diag.title')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">{t('policy.preset.label')}</div>
        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={applyPresetConservative}
            data-testid="policy-preset-conservative"
          >
            {t('policy.preset.conservative')}
          </button>
          <button className="btn btn-secondary" onClick={applyPresetBalanced}>
            {t('policy.preset.balanced')}
          </button>
          <button className="btn btn-secondary" onClick={applyPresetAggressive}>
            {t('policy.preset.aggressive')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">{t('policy.section.humanizer')}</div>
        <CheckboxRow
          checked={config.humanizer.enabled}
          onChange={(v): void => updateHumanizer('enabled', v)}
          testId="hum-enabled"
        />
        <RangeField
          label={t('policy.field.preActionDelayMs')}
          value={config.humanizer.preActionDelayMs}
          onChange={(v): void => updateHumanizer('preActionDelayMs', v)}
          step={1}
          testIdPrefix="hum-pre"
        />
        <RangeField
          label={t('policy.field.postActionDelayMs')}
          value={config.humanizer.postActionDelayMs}
          onChange={(v): void => updateHumanizer('postActionDelayMs', v)}
          step={1}
          testIdPrefix="hum-post"
        />
        <NumberField
          label={t('policy.field.clickJitterPx')}
          value={config.humanizer.clickJitterPx}
          onChange={(v): void => updateHumanizer('clickJitterPx', v)}
          step={1}
          testId="hum-click-jitter"
        />
        <RangeField
          label={t('policy.field.charsPerSecond')}
          value={config.humanizer.charsPerSecond}
          onChange={(v): void => updateHumanizer('charsPerSecond', v)}
          step={0.1}
          testIdPrefix="hum-cps"
        />
        <RangeField
          label={t('policy.field.punctuationPauseMs')}
          value={config.humanizer.punctuationPauseMs}
          onChange={(v): void => updateHumanizer('punctuationPauseMs', v)}
          step={1}
          testIdPrefix="hum-punc"
        />
        <NumberField
          label={t('policy.field.typoProbability')}
          value={config.humanizer.typoProbability}
          onChange={(v): void => updateHumanizer('typoProbability', v)}
          step={0.01}
          testId="hum-typo"
        />
        <NumberField
          label={t('policy.field.longPauseProbability')}
          value={config.humanizer.longPauseProbability}
          onChange={(v): void => updateHumanizer('longPauseProbability', v)}
          step={0.01}
          testId="hum-long-prob"
        />
        <RangeField
          label={t('policy.field.longPauseMs')}
          value={config.humanizer.longPauseMs}
          onChange={(v): void => updateHumanizer('longPauseMs', v)}
          step={1}
          testIdPrefix="hum-long"
        />
        <RangeField
          label={t('policy.field.readDelayMs')}
          value={config.humanizer.readDelayMs}
          onChange={(v): void => updateHumanizer('readDelayMs', v)}
          step={1}
          testIdPrefix="hum-read"
        />
      </div>

      <div className="card">
        <div className="card-title">{t('policy.section.rateLimiter')}</div>
        <CheckboxRow
          checked={config.rateLimiter.enabled}
          onChange={(v): void => updateRateLimiter('enabled', v)}
          testId="rl-enabled"
        />
        <NumberField
          label={t('policy.field.globalPerHour')}
          value={config.rateLimiter.globalPerHour}
          onChange={(v): void => updateRateLimiter('globalPerHour', v)}
          step={1}
          testId="rl-global"
        />
        <NumberField
          label={t('policy.field.perContactPerDay')}
          value={config.rateLimiter.perContactPerDay}
          onChange={(v): void => updateRateLimiter('perContactPerDay', v)}
          step={1}
          testId="rl-per-contact"
        />
        <NumberField
          label={t('policy.field.minIntervalMs')}
          value={config.rateLimiter.minIntervalMs}
          onChange={(v): void => updateRateLimiter('minIntervalMs', v)}
          step={1}
          testId="rl-min-interval"
        />
        <NumberField
          label={t('policy.field.newContactCooldownMs')}
          value={config.rateLimiter.newContactCooldownMs}
          onChange={(v): void => updateRateLimiter('newContactCooldownMs', v)}
          step={1}
          testId="rl-cooldown"
        />
      </div>

      <div className="card">
        <div className="card-title">{t('policy.section.schedule')}</div>
        <CheckboxRow
          checked={config.schedule.enabled}
          onChange={(v): void => updateSchedule('enabled', v)}
          testId="sched-enabled"
        />
        <NumberField
          label={t('policy.field.afkProbability')}
          value={config.schedule.afkProbability}
          onChange={(v): void => updateSchedule('afkProbability', v)}
          step={0.01}
          testId="sched-afk-prob"
        />
        <RangeField
          label={t('policy.field.afkDurationMs')}
          value={config.schedule.afkDurationMs}
          onChange={(v): void => updateSchedule('afkDurationMs', v)}
          step={1}
          testIdPrefix="sched-afk-dur"
        />
        <div className="form-group">
          <label className="form-label">{t('policy.field.windows')}</label>
          <textarea
            className="form-input form-textarea"
            rows={6}
            value={windowsJson}
            onChange={(e): void => handleWindowsJsonChange(e.target.value)}
            data-testid="sched-windows-json"
          />
          {windowsJsonError ? (
            <div className="form-hint policy-error">{windowsJsonError}</div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-title">{t('policy.section.breaker')}</div>
        <CheckboxRow
          checked={config.circuitBreaker.enabled}
          onChange={(v): void => updateBreaker('enabled', v)}
          testId="cb-enabled"
        />
        <NumberField
          label={t('policy.field.consecutiveAiFailures')}
          value={config.circuitBreaker.consecutiveAiFailures}
          onChange={(v): void => updateBreaker('consecutiveAiFailures', v)}
          step={1}
          testId="cb-ai-failures"
        />
        <NumberField
          label={t('policy.field.consecutiveRpaFailures')}
          value={config.circuitBreaker.consecutiveRpaFailures}
          onChange={(v): void => updateBreaker('consecutiveRpaFailures', v)}
          step={1}
          testId="cb-rpa-failures"
        />
        <NumberField
          label={t('policy.field.duplicateReplyCount')}
          value={config.circuitBreaker.duplicateReplyCount}
          onChange={(v): void => updateBreaker('duplicateReplyCount', v)}
          step={1}
          testId="cb-dup"
        />
        <NumberField
          label={t('policy.field.screenshotFreezeMs')}
          value={config.circuitBreaker.screenshotFreezeMs}
          onChange={(v): void => updateBreaker('screenshotFreezeMs', v)}
          step={1}
          testId="cb-freeze"
        />
        <div className="form-group">
          <label className="form-label">{t('policy.field.bannedKeywords')}</label>
          <textarea
            className="form-input form-textarea"
            rows={4}
            value={bannedKeywordsText}
            onChange={(e): void => handleBannedKeywordsChange(e.target.value)}
            data-testid="cb-banned-keywords"
          />
        </div>
      </div>

      <div className="form-actions">
        <button
          className="btn btn-secondary"
          onClick={handleReload}
          style={{ flex: 1 }}
          data-testid="policy-reload"
        >
          {t('policy.reloadDefaults')}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleSave}
          style={{ flex: 1 }}
          disabled={!canSave}
          data-testid="policy-save"
        >
          {t('policy.save')}
        </button>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function CheckboxRow({
  checked,
  onChange,
  testId
}: {
  checked: boolean
  onChange: (v: boolean) => void
  testId: string
}): JSX.Element {
  return (
    <div className="form-group policy-checkbox-row">
      <label className="policy-checkbox-label">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e): void => onChange(e.target.checked)}
          data-testid={testId}
        />
        <span>{t('policy.field.enabled')}</span>
      </label>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step,
  testId
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  testId: string
}): JSX.Element {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        type="number"
        step={step}
        value={value}
        onChange={(e): void => {
          const n = e.target.value === '' ? 0 : Number(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
        data-testid={testId}
      />
    </div>
  )
}

function RangeField({
  label,
  value,
  onChange,
  step,
  testIdPrefix
}: {
  label: string
  value: [number, number]
  onChange: (v: [number, number]) => void
  step: number
  testIdPrefix: string
}): JSX.Element {
  const invalid = value[0] > value[1]
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div className="policy-range-row">
        <input
          className="form-input policy-range-input"
          type="number"
          step={step}
          value={value[0]}
          onChange={(e): void => {
            const n = e.target.value === '' ? 0 : Number(e.target.value)
            if (!Number.isNaN(n)) onChange([n, value[1]])
          }}
          data-testid={`${testIdPrefix}-min`}
        />
        <span className="policy-range-sep">{t('policy.range.to')}</span>
        <input
          className="form-input policy-range-input"
          type="number"
          step={step}
          value={value[1]}
          onChange={(e): void => {
            const n = e.target.value === '' ? 0 : Number(e.target.value)
            if (!Number.isNaN(n)) onChange([value[0], n])
          }}
          data-testid={`${testIdPrefix}-max`}
        />
      </div>
      {invalid ? (
        <div className="form-hint policy-error" data-testid={`${testIdPrefix}-error`}>
          {t('policy.invalidRange')}
        </div>
      ) : null}
    </div>
  )
}
