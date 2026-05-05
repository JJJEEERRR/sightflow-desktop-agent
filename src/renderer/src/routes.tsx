import { JSX } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layout/AppLayout'
import { ControlPage } from './pages/ControlPage'
import { SettingsPage } from './pages/SettingsPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { AntiDetectionPage } from './pages/AntiDetectionPage'

/**
 * Top-level renderer routing. HashRouter is used (not BrowserRouter) because
 * Electron loads the renderer over `file://` in production; reloading on a
 * browser-history path would 404 against the static asset server. Hash
 * routes bypass that by keeping the path entirely in `window.location.hash`.
 *
 * The `*` catch-all redirects unknown routes home so a stale deep-link from
 * a previous build can't strand the user on a blank page.
 */
export function AppRoutes(): JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<ControlPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="/anti-detection" element={<AntiDetectionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
