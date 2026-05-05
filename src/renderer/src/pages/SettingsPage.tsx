import { JSX, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'
import type { AppKind } from '../types'

interface OkResult<T = unknown> {
  success: true
  data?: T
}

interface ErrResult {
  success: false
  error?: string
}

type IpcResult<T = unknown> = OkResult<T> | ErrResult

interface PersistedSettings {
  apiKey: string | undefined
  model: string | undefined
  baseURL: string | undefined
  systemPrompt: string | undefined
  appType: AppKind | undefined
}

interface UpdateConfigPayload {
  apiKey?: string
  model?: string
  baseURL?: string
  systemPrompt?: string
  appType?: AppKind
}

interface TestConnectionPayload {
  apiKey: string
  model?: string
  baseURL?: string
}

/**
 * `/settings` route. Reads/writes the AI model configuration. The draft
 * lives in the global settings store so ControlPage can read the same
 * apiKey/appType without round-tripping through `settings:getAll` again.
 *
 * Phase 5 PR2 migration:
 *  - `settings:set` → `useMutation`. On success, invalidates
 *    `['settings:getAll']` so any consumer that read it via `useQuery`
 *    picks up the persisted values on the next read. (As of PR2 the
 *    bootstrap is still a one-shot hook, but the invalidation costs
 *    nothing and future-proofs a switch to useQuery.)
 *  - `engine:updateConfig` → `useMutation` (best-effort hot-reload of
 *    the running engine; failure is non-fatal).
 *  - `engine:testConnection` → `useMutation`. The button is disabled
 *    while `isPending` and toggles its label between "Test connection"
 *    and "Testing…".
 */
export function SettingsPage(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const draft = useSettingsStore((s) => s.draft)
  const patchDraft = useSettingsStore((s) => s.setDraft)
  const pushToast = useToastStore((s) => s.push)

  const updateEngineConfig = useMutation<unknown, Error, UpdateConfigPayload>({
    mutationFn: (payload) => ipc.invoke('engine:updateConfig', payload)
  })

  const saveSettings = useMutation<unknown, Error, PersistedSettings>({
    mutationFn: (payload) => ipc.invoke('settings:set', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings:getAll'] })
      pushToast(t('settings.saved'), 'success')
      // Best-effort hot-reload of the running engine. Failures are
      // non-fatal — the persisted settings are already saved and will be
      // picked up on the next start. updateEngineConfig has its own error
      // handler swallowing the rejection so it doesn't surface a toast.
      updateEngineConfig.mutate({
        apiKey: draft.apiKey || undefined,
        model: draft.model || undefined,
        baseURL: draft.baseURL || undefined,
        systemPrompt: draft.systemPrompt || undefined,
        appType: draft.appType
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      pushToast(message, 'error')
    }
  })

  const testConnection = useMutation<IpcResult, Error, TestConnectionPayload>({
    mutationFn: (payload) => ipc.invoke<IpcResult>('engine:testConnection', payload),
    onSuccess: (result) => {
      if (result?.success) {
        pushToast(t('settings.testConnection.success'), 'success')
      } else {
        pushToast(
          `${t('settings.testConnection.fail')}: ${(result as ErrResult)?.error ?? ''}`,
          'error'
        )
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      pushToast(`${t('settings.testConnection.fail')}: ${message}`, 'error')
    }
  })

  const handleSave = useCallback((): void => {
    saveSettings.mutate({
      apiKey: draft.apiKey,
      model: draft.model,
      baseURL: draft.baseURL,
      systemPrompt: draft.systemPrompt,
      appType: draft.appType
    })
  }, [draft, saveSettings])

  const handleTestConnection = useCallback((): void => {
    if (!draft.apiKey) return
    testConnection.mutate({
      apiKey: draft.apiKey,
      model: draft.model || undefined,
      baseURL: draft.baseURL || undefined
    })
  }, [draft.apiKey, draft.model, draft.baseURL, testConnection])

  return (
    <div className="slide-up">
      <div className="card">
        <div className="card-title">{t('settings.ai')}</div>

        <div className="form-group">
          <label className="form-label">{t('settings.apiKey')}</label>
          <input
            className="form-input"
            type="password"
            value={draft.apiKey ?? ''}
            onChange={(e): void => patchDraft({ apiKey: e.target.value })}
            placeholder={t('settings.apiKey.placeholder')}
            autoComplete="off"
          />
          <div className="form-hint">{t('settings.apiKey.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.baseURL')}</label>
          <input
            className="form-input"
            value={draft.baseURL ?? ''}
            onChange={(e): void => patchDraft({ baseURL: e.target.value })}
            placeholder={t('settings.baseURL.placeholder')}
          />
          <div className="form-hint">{t('settings.baseURL.hint')}</div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.model')}</label>
          <input
            className="form-input"
            value={draft.model ?? 'doubao-seed-2-0-lite-260215'}
            disabled
            placeholder={t('settings.model.placeholder')}
          />
        </div>

        <div className="form-group">
          <label className="form-label">{t('settings.systemPrompt')}</label>
          <textarea
            className="form-input form-textarea"
            value={draft.systemPrompt ?? ''}
            onChange={(e): void => patchDraft({ systemPrompt: e.target.value })}
            placeholder={t('settings.systemPrompt.placeholder')}
            rows={6}
          />
        </div>

        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={handleTestConnection}
            style={{ flex: 1 }}
            disabled={!draft.apiKey || testConnection.isPending}
          >
            {testConnection.isPending
              ? t('settings.testConnection.testing')
              : t('settings.testConnection')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            style={{ flex: 1 }}
            disabled={saveSettings.isPending}
          >
            {t('settings.save')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">{t('policy.title')}</div>
        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={(): void => {
              void navigate('/anti-detection')
            }}
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
