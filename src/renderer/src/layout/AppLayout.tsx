import { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import logoUrl from '../assets/logo.png'
import { useEngineSubscription } from '../hooks/useEngineSubscription'
import { useSettingsBootstrap } from '../hooks/useSettingsBootstrap'
import { useEngineStore, type EngineStatus } from '../stores/engine'
import { useToastStore } from '../stores/toast'
import { ActivityIcon, GearIcon } from '../components/icons'
import { cn } from '../lib/utils'

/**
 * Single shared chrome for every route — header, page outlet, bottom nav,
 * toast overlay. Mounts the two top-level subscribers (`useEngineSubscription`
 * pulls `engine:state` / `engine:log` push events into the engine store;
 * `useSettingsBootstrap` does a one-shot `settings:getAll`) so that pages
 * never need to repeat that wiring.
 *
 * Phase 5 PR4: every legacy `.app-*`/`.bottom-*` class was replaced with
 * Tailwind utilities + shadcn tokens. The `drag-region` / `no-drag`
 * utilities (defined in `index.css`) preserve the Electron frame-drag
 * affordance the old `-webkit-app-region` rules carried.
 */
export function AppLayout(): JSX.Element {
  useEngineSubscription()
  useSettingsBootstrap()

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background">
      <header className="drag-region relative z-10 flex select-none items-center gap-3 border-b border-border bg-background/75 px-5 pb-3.5 pt-10 backdrop-blur-xl">
        <img src={logoUrl} alt="SightFlow" className="h-[22px] w-auto shrink-0 opacity-95" />
        <RouteTitle />
        <StatusPill />
      </header>

      <div className="relative z-[1] flex-1 overflow-y-auto p-4">
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
  const headerTitleClass =
    'ml-2 text-[13px] font-semibold uppercase tracking-[0.04em] text-muted-foreground'
  if (pathname === '/diagnostics') {
    return <span className={headerTitleClass}>{t('diag.title')}</span>
  }
  if (pathname === '/anti-detection') {
    return <span className={headerTitleClass}>{t('policy.title')}</span>
  }
  return null
}

/**
 * Compact engine-status badge displayed at the right edge of the header.
 * Uses the same color palette as ControlPage's larger status indicator.
 */
function StatusPill(): JSX.Element {
  const { t } = useTranslation()
  const status = useEngineStore((s) => s.status)
  const label = labelFor(status, t)
  return (
    <span
      role="status"
      aria-live="polite"
      className="ml-auto inline-flex items-center gap-1.5 text-[11px] opacity-85"
      data-testid="header-status"
    >
      <StatusDot status={status} />
      <span>{label}</span>
    </span>
  )
}

/**
 * Coloured status dot used in both the header pill and the ControlPage
 * indicator. Centralized so the two locations cannot drift visually.
 */
export function StatusDot({ status }: { status: EngineStatus }): JSX.Element {
  const color =
    status === 'running'
      ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.45)] animate-pulse-dot'
      : status === 'error'
        ? 'bg-destructive'
        : 'bg-muted-foreground/60'
  return <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 rounded-full', color)} />
}

type TFunction = ReturnType<typeof useTranslation>['t']

function labelFor(status: EngineStatus, t: TFunction): string {
  if (status === 'running') return t('status.running')
  if (status === 'error') return t('status.error')
  return t('status.idle')
}

/**
 * Bottom navigation bar — four `<NavLink>`s, one per top-level route.
 * Tailwind-driven active state matches the legacy green-tinted accent
 * pill (`.bottom-btn-settings.active` in the pre-PR4 stylesheet).
 */
function BottomNav(): JSX.Element {
  const { t } = useTranslation()
  return (
    <nav
      className="relative z-10 flex items-center justify-center gap-2 border-t border-border bg-background/75 px-5 pb-5 pt-4 backdrop-blur-xl"
      aria-label="primary"
    >
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
  return cn(
    'no-drag inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/60 text-muted-foreground shadow-inner backdrop-blur-md transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-border hover:bg-secondary hover:text-foreground [&_svg]:h-5 [&_svg]:w-5',
    isActive && 'border-primary/30 bg-primary/10 text-primary hover:text-primary'
  )
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
 * Renders queued toasts from `useToastStore`. Tailwind utilities replace
 * the `.toast.{type}.show` classes the legacy CSS used; the
 * `data-testid="toast"` attribute is the supported test selector after
 * PR4 (App.test.tsx asserts on it instead of `.toast.show`).
 */
function ToastOutlet(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          data-toast-type={toast.type}
          className={cn(
            'pointer-events-none fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full px-[18px] py-2 text-xs font-medium backdrop-blur-md transition-all duration-300 ease-out',
            toast.type === 'success' && 'border border-primary/20 bg-primary/10 text-primary',
            toast.type === 'error' &&
              'border border-destructive/20 bg-destructive/10 text-destructive'
          )}
        >
          {toast.message}
        </div>
      ))}
    </>
  )
}
