import { create } from 'zustand'
import type { AppSettings } from '../types'

interface SettingsStore {
  draft: AppSettings
  loaded: boolean
  setDraft: (patch: Partial<AppSettings>) => void
  setLoaded: (s: AppSettings) => void
  reset: () => void
}

const EMPTY_DRAFT: AppSettings = {
  apiKey: '',
  model: '',
  baseURL: '',
  systemPrompt: '',
  appType: 'weixin'
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  draft: EMPTY_DRAFT,
  loaded: false,
  setDraft: (patch) => set((state) => ({ draft: { ...state.draft, ...patch } })),
  setLoaded: (s) => set({ draft: s, loaded: true }),
  reset: () => set({ draft: EMPTY_DRAFT, loaded: false })
}))
