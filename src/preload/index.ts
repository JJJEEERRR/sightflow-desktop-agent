import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'

// Window augmentation (kept here so it activates whenever this module is included
// in a project, not only when index.d.ts happens to be imported). The same shape
// is also re-declared in index.d.ts for consumers that import only the .d.ts.
declare global {
  interface Window {
    electron: ElectronHandler
    osInfo: { platform: NodeJS.Platform }
  }
}

/**
 * Generic IPC payload type. We deliberately keep `unknown` rather than `any`
 * here because (a) renderer-side callers must explicitly narrow before use
 * and (b) main-side handlers can return arbitrary serialisable values. Use a
 * typed wrapper at each call site if you want stronger guarantees.
 */
export type IpcArg = unknown

export type IpcOnCallback = (...args: IpcArg[]) => void
export type IpcUnsubscribe = () => void

export interface ElectronHandler {
  invoke: <T = IpcArg>(channel: string, ...args: IpcArg[]) => Promise<T>
  on: (channel: string, callback: IpcOnCallback) => IpcUnsubscribe
  send: (channel: string, ...args: IpcArg[]) => void
}

const electronHandler: ElectronHandler = {
  invoke: <T = IpcArg>(channel: string, ...args: IpcArg[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  on: (channel, callback) => {
    const handler = (_event: IpcRendererEvent, ...args: IpcArg[]): void => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  send: (channel, ...args) => ipcRenderer.send(channel, ...args)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronHandler)
    contextBridge.exposeInMainWorld('osInfo', { platform: process.platform })
  } catch (error) {
    console.error(error)
  }
} else {
  // Legacy fallback for non-isolated contexts. Window is augmented above.
  window.electron = electronHandler
  window.osInfo = { platform: process.platform }
}
