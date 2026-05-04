import { contextBridge, ipcRenderer } from 'electron'

// Window augmentation (kept here so it activates whenever this module is included
// in a project, not only when index.d.ts happens to be imported). The same shape
// is also re-declared in index.d.ts for consumers that import only the .d.ts.
declare global {
  interface Window {
    electron: ElectronHandler
    osInfo: { platform: NodeJS.Platform }
  }
}

const electronHandler = {
  invoke: (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, callback: (...args: any[]) => void) => {
    const handler = (_: any, ...args: any[]) => callback(...args)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args)
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

export type ElectronHandler = typeof electronHandler
