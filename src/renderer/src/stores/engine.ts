import { create } from 'zustand'

export type EngineStatus = 'idle' | 'running' | 'error'

interface EngineStore {
  status: EngineStatus
  lastError: string | null
  setStatus: (s: EngineStatus) => void
  setLastError: (e: string | null) => void
  reset: () => void
}

export const useEngineStore = create<EngineStore>((set) => ({
  status: 'idle',
  lastError: null,
  setStatus: (status) => set({ status }),
  setLastError: (lastError) => set({ lastError }),
  reset: () => set({ status: 'idle', lastError: null })
}))
