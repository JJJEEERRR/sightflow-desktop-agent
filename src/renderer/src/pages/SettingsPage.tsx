import { JSX, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../i18n'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settings'
import { useToastStore } from '../stores/toast'

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
 * `/settings` route. Reads/writes the AI model configuration. The draft
 * lives in the global settings store so ControlPage can read the same
 * apiKey/appType without round-tripping through `settings:getAll` again.
 *
 * Test connection and save still use `ipc.invoke` directly — moving these
 * to `useMutation` is a PR2 task (see plan §"PR2 — Data layer migration").
 */
export function SettingsPage(): JSX.Element {
  const navigate = useNavigate()
  const draft = useSettingsStore((s) => s.draft)
  const patchDraft = useSettingsStore((s) => s.setDraft)
  const pushToast = useToastStore((s) => s.push)
  const [testing, setTesting] = useState(false)

  const handleSave = useCallback(async () => {
    try {
      await ipc.invoke('settings:set', {
        apiKey: draft.apiKey,
        model: draft.model,
        baseURL: draft.baseURL,
        systemPrompt: draft.systemPrompt,
        appType: draft.appType
      })
      // Best-effort hot-reload of the running engine. Failures here are
      // non-fatal — the persisted settings are already saved and will be
      // picked up on the next start.
      void ipc
        .invoke('engine:updateConfig', {
          apiKey: draft.apiKey || undefined,
          model: draft.model || undefined,
          baseURL: draft.baseURL || undefined,
          systemPrompt: draft.systemPrompt || undefined,
          appType: draft.appType
        })
        .catch(() => undefined)
      pushToast(t('settings.saved'), 'success')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      pushToast(message, 'error')
    }
  }, [draft, pushToast])

  const handleTestConnection = useCallback(async () => {
    if (!draft.apiKey) return
    setTesting(true)
    try {
      const result = await ipc.invoke<IpcResult>('engine:testConnection', {
        apiKey: draft.apiKey,
        model: draft.model || undefined,
        baseURL: draft.baseURL || undefined
      })
      if (result?.success) {
        pushToast(t('settings.testConnection.success'), 'success')
      } else {
        pushToast(
          `${t('settings.testConnection.fail')}: ${(result as ErrResult)?.error ?? ''}`,
          'error'
        )
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      pushToast(`${t('settings.testConnection.fail')}: ${message}`, 'error')
    } finally {
      setTesting(false)
    }
  }, [draft.apiKey, draft.model, draft.baseURL, pushToast])

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
            disabled={!draft.apiKey || testing}
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
