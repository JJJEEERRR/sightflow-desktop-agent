import { JSX, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
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
 *
 * Phase 5 PR4: replaced `.btn`/`.form-input`/`.card` classes with
 * shadcn primitives (`Button`, `Input`, `Textarea`, `Label`, `Card`).
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
    <div className="animate-slide-up space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.ai')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="settings-apiKey">{t('settings.apiKey')}</Label>
            <Input
              id="settings-apiKey"
              type="password"
              value={draft.apiKey ?? ''}
              onChange={(e): void => patchDraft({ apiKey: e.target.value })}
              placeholder={t('settings.apiKey.placeholder')}
              autoComplete="off"
            />
            <div className="text-[10px] text-muted-foreground/80">{t('settings.apiKey.hint')}</div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-baseURL">{t('settings.baseURL')}</Label>
            <Input
              id="settings-baseURL"
              value={draft.baseURL ?? ''}
              onChange={(e): void => patchDraft({ baseURL: e.target.value })}
              placeholder={t('settings.baseURL.placeholder')}
            />
            <div className="text-[10px] text-muted-foreground/80">{t('settings.baseURL.hint')}</div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-model">{t('settings.model')}</Label>
            <Input
              id="settings-model"
              value={draft.model ?? 'doubao-seed-2-0-lite-260215'}
              disabled
              placeholder={t('settings.model.placeholder')}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settings-systemPrompt">{t('settings.systemPrompt')}</Label>
            <Textarea
              id="settings-systemPrompt"
              value={draft.systemPrompt ?? ''}
              onChange={(e): void => patchDraft({ systemPrompt: e.target.value })}
              placeholder={t('settings.systemPrompt.placeholder')}
              rows={6}
            />
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={handleTestConnection}
              disabled={!draft.apiKey || testConnection.isPending}
            >
              {testConnection.isPending
                ? t('settings.testConnection.testing')
                : t('settings.testConnection')}
            </Button>
            <Button className="flex-1" onClick={handleSave} disabled={saveSettings.isPending}>
              {t('settings.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('policy.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="secondary"
            className="w-full"
            onClick={(): void => {
              void navigate('/anti-detection')
            }}
            data-testid="open-anti-detection"
          >
            {t('policy.openSettings')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
