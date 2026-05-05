import { create } from 'zustand'

export interface ToastEntry {
  id: string
  message: string
  type: 'success' | 'error'
  createdAt: number
}

interface ToastStore {
  toasts: ToastEntry[]
  push: (msg: string, type: 'success' | 'error') => void
  dismiss: (id: string) => void
  clear: () => void
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (message, type) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set({ toasts: [...get().toasts, { id, message, type, createdAt: Date.now() }] })
    setTimeout(() => get().dismiss(id), 3000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  clear: () => set({ toasts: [] })
}))
