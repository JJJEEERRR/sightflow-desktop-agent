import { useEffect } from 'react'
import { ipc } from '../lib/ipc'
import { useSettingsStore } from '../stores/settings'
import type { AppSettings } from '../types'

/**
 * One-shot fetch of `settings:getAll` on app mount, seeded into the global
 * settings store. Subsequent reads (e.g. SettingsPage form prefill,
 * ControlPage start-engine call) consume the store directly.
 *
 * Failures are intentionally silent: the form can still operate from the
 * empty draft, and an `engine:start` attempt will surface its own toast if
 * the IPC layer is misbehaving.
 */
export function useSettingsBootstrap(): void {
  const setLoaded = useSettingsStore((s) => s.setLoaded)
  const loaded = useSettingsStore((s) => s.loaded)
  useEffect(() => {
    if (loaded) return
    void (async () => {
      try {
        const all = await ipc.invoke<AppSettings>('settings:getAll')
        setLoaded({ ...all, appType: all?.appType ?? 'weixin' })
      } catch {
        // Swallow: a missing settings:getAll handler shouldn't block the UI.
      }
    })()
  }, [loaded, setLoaded])
}
