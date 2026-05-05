/**
 * Thin typed wrapper around `window.electron.invoke`. Centralized so:
 *  - Tests can stub one place (`vi.spyOn(ipc, 'invoke')`).
 *  - Future ergonomics (logging, retries, telemetry) attach in one spot.
 *  - Defensive null-check survives jsdom test envs where `window.electron`
 *    isn't installed unless the test fixture explicitly does so.
 */
export const ipc = {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
    const electron = (
      window as unknown as { electron?: { invoke: (...args: unknown[]) => Promise<T> } }
    ).electron
    if (!electron) {
      return Promise.reject(new Error(`window.electron not installed (channel: ${channel})`))
    }
    return payload === undefined ? electron.invoke(channel) : electron.invoke(channel, payload)
  }
}
