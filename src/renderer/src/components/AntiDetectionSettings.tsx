import { useCallback, useMemo, useState, JSX } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ipc } from '../lib/ipc'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'

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

interface OcrConfig {
  enabled: boolean
  sampleIntervalMs: number
  language: string
}

interface AntiDetectionConfig {
  humanizer: HumanizerConfig
  rateLimiter: RateLimiterConfig
  schedule: ScheduleConfig
  circuitBreaker: CircuitBreakerConfig
  ocr: OcrConfig
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

const POLICY_GET_KEY = ['policy:get'] as const
const POLICY_SNAPSHOT_KEY = ['policy:snapshot'] as const

interface AntiDetectionSettingsProps {
  onToast?: (msg: string, type: 'success' | 'error') => void
  onNavigateDiagnostics?: () => void
}

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

/**
 * Anti-detection (policy) settings. Phase 5 PR2 fully migrated to
 * react-query; PR4 swaps the hand-written `.btn`/`.form-input`/`.card`
 * classes for shadcn primitives + Tailwind utilities.
 *
 * The native `<input type="checkbox">` is preserved (rather than swapped
 * for shadcn's `<Switch>`) because the existing test suite asserts on
 * `.checked` of a checkbox element by `data-testid`. PR4 leaves the
 * accessible API intact and only restyles via Tailwind.
 */
export function AntiDetectionSettings({
  onToast,
  onNavigateDiagnostics
}: AntiDetectionSettingsProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [config, setConfig] = useState<AntiDetectionConfig | null>(null)
  const [windowsJson, setWindowsJson] = useState<string>('{}')
  const [windowsJsonError, setWindowsJsonError] = useState<string | null>(null)
  const [bannedKeywordsText, setBannedKeywordsText] = useState<string>('')

  const applyServerConfig = useCallback((cfg: AntiDetectionConfig): void => {
    setConfig(cfg)
    setWindowsJson(JSON.stringify(cfg.schedule.windows ?? {}, null, 2))
    setWindowsJsonError(null)
    setBannedKeywordsText((cfg.circuitBreaker.bannedKeywords ?? []).join('\n'))
  }, [])

  const { data: serverConfig } = useQuery<AntiDetectionConfig | null>({
    queryKey: POLICY_GET_KEY,
    queryFn: async () => (await ipc.invoke<AntiDetectionConfig | null>('policy:get')) ?? null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const [lastSyncedServerConfig, setLastSyncedServerConfig] = useState<
    AntiDetectionConfig | null | undefined
  >(undefined)
  if (serverConfig !== lastSyncedServerConfig) {
    setLastSyncedServerConfig(serverConfig)
    if (serverConfig) applyServerConfig(serverConfig)
  }

  const { data: snapshot = null } = useQuery<PolicySnapshot | null>({
    queryKey: POLICY_SNAPSHOT_KEY,
    queryFn: async () => (await ipc.invoke<PolicySnapshot | null>('policy:snapshot')) ?? null,
    refetchInterval: 2_000,
    staleTime: 1_000
  })

  const savePolicy = useMutation<SetResult | undefined, Error, AntiDetectionConfig>({
    mutationFn: (payload) => ipc.invoke<SetResult>('policy:set', payload),
    onSuccess: (result) => {
      if (result?.success) {
        applyServerConfig(result.config)
        queryClient.invalidateQueries({ queryKey: POLICY_GET_KEY })
        queryClient.invalidateQueries({ queryKey: POLICY_SNAPSHOT_KEY })
        onToast?.(t('policy.saved'), 'success')
      } else {
        const err = result?.error ?? ''
        onToast?.(`${t('policy.saveFailed')}: ${err}`, 'error')
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      onToast?.(`${t('policy.saveFailed')}: ${message}`, 'error')
    }
  })

  const resetBreaker = useMutation<unknown, Error, void>({
    mutationFn: () => ipc.invoke('policy:resetBreaker'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: POLICY_SNAPSHOT_KEY })
      onToast?.(t('policy.resetBreakerDone'), 'success')
    }
  })

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

  const canSave = !!config && !rangeInvalid && !windowsJsonError && !savePolicy.isPending

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
  const updateOcr = useCallback(<K extends keyof OcrConfig>(key: K, value: OcrConfig[K]): void => {
    setConfig((prev) => (prev ? { ...prev, ocr: { ...prev.ocr, [key]: value } } : prev))
  }, [])

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
    if (serverConfig) applyServerConfig(serverConfig)
  }, [serverConfig, applyServerConfig])
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
    [updateSchedule, t]
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

  const handleSave = useCallback((): void => {
    if (!config || !canSave) return
    savePolicy.mutate(config)
  }, [config, canSave, savePolicy])

  const handleReload = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: POLICY_GET_KEY })
  }, [queryClient])

  const handleResetBreaker = useCallback((): void => {
    resetBreaker.mutate()
  }, [resetBreaker])

  if (!config) {
    return <div className="animate-slide-up" data-testid="policy-loading" />
  }

  const breakerTripped = snapshot?.circuitBreaker.state.tripped === true
  const breakerReason =
    snapshot?.circuitBreaker.state.tripped === true ? snapshot.circuitBreaker.state.reason : ''

  return (
    <div className="animate-slide-up space-y-3">
      {breakerTripped ? (
        <Card
          data-testid="policy-breaker-banner"
          className="border-destructive/25 bg-destructive/[0.08]"
        >
          <CardHeader>
            <CardTitle className="text-destructive">{t('policy.tripped')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 font-mono text-xs text-foreground">{breakerReason}</div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={handleResetBreaker}
                disabled={resetBreaker.isPending}
                data-testid="policy-reset-breaker"
              >
                {t('policy.resetBreaker')}
              </Button>
              {onNavigateDiagnostics ? (
                <Button variant="secondary" onClick={onNavigateDiagnostics}>
                  {t('diag.title')}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.preset.label')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={applyPresetConservative}
              data-testid="policy-preset-conservative"
            >
              {t('policy.preset.conservative')}
            </Button>
            <Button variant="secondary" onClick={applyPresetBalanced}>
              {t('policy.preset.balanced')}
            </Button>
            <Button variant="secondary" onClick={applyPresetAggressive}>
              {t('policy.preset.aggressive')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.section.humanizer')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.section.rateLimiter')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.section.schedule')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
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
          <div className="space-y-1.5">
            <Label>{t('policy.field.windows')}</Label>
            <Textarea
              rows={6}
              value={windowsJson}
              onChange={(e): void => handleWindowsJsonChange(e.target.value)}
              data-testid="sched-windows-json"
              className="font-mono"
            />
            {windowsJsonError ? (
              <div className="text-[10px] text-destructive">{windowsJsonError}</div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.section.breaker')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
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
          <div className="space-y-1.5">
            <Label>{t('policy.field.bannedKeywords')}</Label>
            <Textarea
              rows={4}
              value={bannedKeywordsText}
              onChange={(e): void => handleBannedKeywordsChange(e.target.value)}
              data-testid="cb-banned-keywords"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.ocr.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <div className="flex items-center">
            <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={config.ocr.enabled}
                onChange={(e): void => updateOcr('enabled', e.target.checked)}
                data-testid="ocr-enabled"
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
              />
              <span>{t('policy.ocr.enabled')}</span>
            </label>
          </div>
          <div className="space-y-1.5">
            <Label>
              {t('policy.ocr.sampleIntervalMs')}: {Math.round(config.ocr.sampleIntervalMs / 1000)}s
            </Label>
            <input
              type="range"
              min={5_000}
              max={120_000}
              step={1_000}
              value={config.ocr.sampleIntervalMs}
              onChange={(e): void => {
                const n = Number(e.target.value)
                if (!Number.isNaN(n)) updateOcr('sampleIntervalMs', n)
              }}
              data-testid="ocr-sample-interval"
              className="w-full accent-primary"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('policy.ocr.language')}</Label>
            <Input
              type="text"
              value={config.ocr.language}
              onChange={(e): void => updateOcr('language', e.target.value)}
              data-testid="ocr-language"
            />
          </div>
          <div className="text-[10px] text-muted-foreground/80">{t('policy.ocr.hint')}</div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={handleReload}
          data-testid="policy-reload"
        >
          {t('policy.reloadDefaults')}
        </Button>
        <Button
          className="flex-1"
          onClick={handleSave}
          disabled={!canSave}
          data-testid="policy-save"
        >
          {t('policy.save')}
        </Button>
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
  const { t } = useTranslation()
  return (
    <div className="flex items-center">
      <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e): void => onChange(e.target.checked)}
          data-testid={testId}
          className="h-3.5 w-3.5 cursor-pointer accent-primary"
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
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
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
  const { t } = useTranslation()
  const invalid = value[0] > value[1]
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step={step}
          value={value[0]}
          onChange={(e): void => {
            const n = e.target.value === '' ? 0 : Number(e.target.value)
            if (!Number.isNaN(n)) onChange([n, value[1]])
          }}
          data-testid={`${testIdPrefix}-min`}
          className={cn('min-w-0 flex-1')}
        />
        <span className="shrink-0 text-[11px] text-muted-foreground/80">
          {t('policy.range.to')}
        </span>
        <Input
          type="number"
          step={step}
          value={value[1]}
          onChange={(e): void => {
            const n = e.target.value === '' ? 0 : Number(e.target.value)
            if (!Number.isNaN(n)) onChange([value[0], n])
          }}
          data-testid={`${testIdPrefix}-max`}
          className="min-w-0 flex-1"
        />
      </div>
      {invalid ? (
        <div className="text-[10px] text-destructive" data-testid={`${testIdPrefix}-error`}>
          {t('policy.invalidRange')}
        </div>
      ) : null}
    </div>
  )
}
