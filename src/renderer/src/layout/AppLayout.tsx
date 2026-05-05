import { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import logoUrl from '../assets/logo.png'
import { useEngineSubscription } from '../hooks/useEngineSubscription'
import { useSettingsBootstrap } from '../hooks/useSettingsBootstrap'
import { useEngineStore, type EngineStatus } from '../stores/engine'
import { useToastStore } from '../stores/toast'
import { ActivityIcon, GearIcon } from '../components/icons'

/**
 * Single shared chrome for every route — header, page outlet, bottom nav,
 * toast overlay. Mounts the two top-level subscribers (`useEngineSubscription`
 * pulls `engine:state` / `engine:log` push events into the engine store;
 * `useSettingsBootstrap` does a one-shot `settings:getAll`) so that pages
 * never need to repeat that wiring.
 */
export function AppLayout(): JSX.Element {
  useEngineSubscription()
  useSettingsBootstrap()

  return (
    <div className="app">
      <header className="app-header">
        <img src={logoUrl} alt="SightFlow" className="app-logo" />
        <RouteTitle />
        <StatusPill />
      </header>

      <div className="app-content">
        <Outlet />
      </div>

      <BottomNav />

      <ToastOutlet />
    </div>
  )
}

function RouteTitle(): JSX.Element | null {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  if (pathname === '/diagnostics') {
    return <span className="app-header-title">{t('diag.title')}</span>
  }
  if (pathname === '/anti-detection') {
    return <span className="app-header-title">{t('policy.title')}</span>
  }
  return null
}

/**
 * Compact engine-status badge displayed at the right edge of the header.
 * Reuses the `.status-dot` class from `index.css` for shape/color so the
 * pill follows the same dark-theme accent palette used by ControlPage's
 * larger status indicator.
 */
function StatusPill(): JSX.Element {
  const { t } = useTranslation()
  const status = useEngineStore((s) => s.status)
  const label = labelFor(status, t)
  return (
    <span
      className="app-header-status"
      role="status"
      aria-live="polite"
      style={{
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        opacity: 0.85
      }}
    >
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

type TFunction = ReturnType<typeof useTranslation>['t']

function labelFor(status: EngineStatus, t: TFunction): string {
  if (status === 'running') return t('status.running')
  if (status === 'error') return t('status.error')
  return t('status.idle')
}

/**
 * Bottom navigation bar — four `<NavLink>`s, one per top-level route.
 * Reuses `.bottom-bar` and `.bottom-btn-settings` (.active variant already
 * exists in index.css). NavLink's `isActive` callback toggles the existing
 * `.active` class so the green-tinted accent state from the legacy custom
 * tab style still applies.
 */
function BottomNav(): JSX.Element {
  const { t } = useTranslation()
  return (
    <nav className="bottom-bar" aria-label="primary">
      <NavLink to="/" end className={navClassName} aria-label={t('control.status')}>
        <HomeIcon />
      </NavLink>
      <NavLink
        to="/settings"
        className={navClassName}
        aria-label="settings"
        data-testid="nav-settings"
      >
        <GearIcon />
      </NavLink>
      <NavLink
        to="/diagnostics"
        className={navClassName}
        aria-label={t('diag.title')}
        data-testid="nav-diagnostics"
      >
        <ActivityIcon />
      </NavLink>
      <NavLink
        to="/anti-detection"
        className={navClassName}
        aria-label={t('policy.title')}
        data-testid="nav-anti-detection"
      >
        <ShieldIcon />
      </NavLink>
    </nav>
  )
}

function navClassName({ isActive }: { isActive: boolean }): string {
  return `bottom-btn bottom-btn-settings${isActive ? ' active' : ''}`
}

function HomeIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </svg>
  )
}

function ShieldIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3z" />
    </svg>
  )
}

/**
 * Renders queued toasts from `useToastStore`. The visible DOM mirrors the
 * legacy `Toast` component (a `.toast.{type}.show` div with the message)
 * so existing test selectors keep working.
 */
function ToastOutlet(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <>
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.type} show`}>
          {toast.message}
        </div>
      ))}
    </>
  )
}
