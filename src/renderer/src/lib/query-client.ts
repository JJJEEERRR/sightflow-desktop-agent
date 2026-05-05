import { QueryClient } from '@tanstack/react-query'

/**
 * Singleton-friendly QueryClient factory. Defaults are tuned for an Electron
 * renderer (no window-focus refetch — the window blurs constantly during
 * automated agent activity), with a small `staleTime` that lets in-page
 * navigations reuse the previous payload without a re-IPC.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 5_000,
        retry: 1
      },
      mutations: {
        retry: 0
      }
    }
  })
}
