# ADR-0013: Renderer foundation — react-router-dom, zustand, @tanstack/react-query

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: frontend, architecture, refactor, phase-5

## Context

By the end of Phase 4 the renderer had organically grown into a single
487-line `App.tsx` that owned every cross-cutting concern at once:
routing (a hand-rolled `useState<View>` + `if`-cascades),
global state (props-drilled `useState<EngineStatus>` and a module-level
`_showToast` imperative singleton),
data fetching (`useEffect` + `window.electron?.invoke` triplets with
manual loading/error/refetch), and the rendered chrome of every screen.

Three follow-on phases on the spec roadmap (Phase 5 PR2 data layer
migration, PR3 i18n migration, PR4 design system) all needed to touch
this file. Continuing to layer features on top of the monolith was
about to push it past 700 LOC, with zero-bandwidth review surface area
for any individual change.

The team agreed to take a surgical pause and lay down a **foundation
PR** (this ADR's subject) that introduces three industry-standard
libraries, splits the renderer along their boundaries, and migrates
exactly one IPC call as proof. Subsequent phases then migrate the rest
incrementally without touching the foundation.

## Decision

We add three production dependencies to the renderer:

1. **`react-router-dom`** for client-side routing. We use `HashRouter`
   (not `BrowserRouter`) because Electron loads the renderer over the
   `file://` scheme in production builds; a browser-history path on
   reload would 404 against the static asset server. Hash routes keep
   the path entirely in `window.location.hash`.

2. **`zustand`** for global state. Stores live in
   `src/renderer/src/stores/`:
   - `engine.ts` — `{ status, lastError }` + setters + reset
   - `settings.ts` — the form draft + a `loaded` flag + setters
   - `toast.ts` — a queue + push/dismiss + auto-dismiss timer

3. **`@tanstack/react-query`** for IPC reads/writes. A single
   `QueryClient` is created once in `App.tsx` (`createQueryClient()`
   factory in `lib/query-client.ts`) with `refetchOnWindowFocus: false`
   (Electron windows blur constantly during automated agent activity
   and we don't want every blur to re-IPC) and a small 5s `staleTime`
   so in-page navigations reuse the previous payload.

### Renderer file layout after PR1

```
src/renderer/src/
├── App.tsx                  ← 29 LOC (was 487). QueryClientProvider
│                              + ErrorBoundary + AppRoutes only.
├── routes.tsx               ← HashRouter + Routes + 4 page mappings
├── layout/AppLayout.tsx     ← header + Outlet + bottom nav (4
│                              NavLinks) + ToastOutlet. Mounts the
│                              two top-level subscribers
│                              (useEngineSubscription,
│                              useSettingsBootstrap).
├── pages/
│   ├── ControlPage.tsx      ← status + start/stop + log viewer
│   ├── SettingsPage.tsx     ← apiKey/model/baseURL/systemPrompt
│   ├── DiagnosticsPage.tsx  ← thin wrapper around DiagnosticsPanel
│   └── AntiDetectionPage.tsx← thin wrapper around
│                              AntiDetectionSettings
├── stores/
│   ├── engine.ts
│   ├── settings.ts
│   └── toast.ts
├── lib/
│   ├── ipc.ts               ← typed `ipc.invoke<T>` wrapper around
│   │                          window.electron.invoke
│   └── query-client.ts      ← createQueryClient() factory
├── hooks/
│   ├── useEngineSubscription.ts
│   └── useSettingsBootstrap.ts
├── components/icons.tsx     ← extracted SVG icons
└── test-utils.tsx           ← renderWithProviders + installFakeElectron
```

### One-channel react-query proof

`DiagnosticsPanel`'s `logs:recent` ring-buffer pull is now driven by
`useQuery({ queryKey: ['logs:recent', 200], queryFn: ..., refetchInterval: 1500 })`.
The live `engine:log-record` push subscriber routes new records into
the same cache via `queryClient.setQueryData(...)` — single source of
truth for the rendered list, with the 1.5s polling acting as a backstop
for any pushed events that arrive while the renderer is detached
(e.g. if the main process restarts).

The other IPC call in `DiagnosticsPanel` (`engine:lifecycle`) keeps
its existing one-shot `useEffect` for now. PR2 migrates it.

### Test infrastructure

`src/renderer/src/test-utils.tsx` centralizes:

- `renderWithProviders(ui, { route? })` — wraps in
  `<QueryClientProvider>` (fresh client per call with `retry: false`,
  `gcTime: 0`, `staleTime: 0` to prevent cache leakage between tests)
  - `<MemoryRouter>` (not HashRouter — jsdom can't drive
    `window.location.hash` cleanly across tests).
- `installFakeElectron(handler)` — listener-tracking `window.electron`
  fake mirroring the inline pattern that already lived in
  `DiagnosticsPanel.test.tsx` and `AntiDetectionSettings.test.tsx`.

Tests that mount `<App />` directly (App.test.tsx) still use bare
`render(...)` because App provides its own QueryClient + HashRouter;
double-wrapping nested routers would break navigation.

## Consequences

### Positive

- **App.tsx 487 → 29 LOC** (94% reduction). Reading App.tsx no longer
  requires reading anything else.
- **Pages are deep-linkable.** `#/settings` and `#/diagnostics` are
  shareable / refreshable. Adding a new page = new `<Route>` + new
  page file. Zero touches to App.tsx.
- **Engine status / toast live in zustand.** No more module-level
  imperative singletons (`_showToast` is gone). Any component can
  `useToastStore.getState().push(...)` without prop drilling.
- **Cache layer in place.** PR2 migrates the remaining 10+ IPC reads
  to `useQuery` mechanically. The one channel (logs:recent) migrated
  here proves the pattern works end-to-end in jsdom tests.
- **Test surface centralized.** `renderWithProviders` is the one
  helper future renderer tests need to know about.

### Negative

- **Slight visual delta.** The bottom bar shifted from a state-driven
  cluster of 2-3 buttons (start/stop + diag + settings) to a
  route-driven cluster of 4 NavLinks (home / settings / diagnostics /
  anti-detection). The start/stop button moved up into the
  ControlPage body. Both visual changes are minor and reuse the
  existing `.bottom-btn` / `.bottom-btn-settings` / `.bottom-btn-play`
  classes from `index.css`.
- **Two top-level subscribers run on every route.**
  `useEngineSubscription` and `useSettingsBootstrap` mount in
  `AppLayout`, so they fire even on /settings or /diagnostics. Cost:
  one IPC `on` registration each + one `settings:getAll` call on first
  mount. Acceptable; the alternative (mounting them only on /) would
  force every page that needs the engine status to re-subscribe.
- **HashRouter persists across test boundaries.** A test that calls
  `navigate('/settings')` mutates `window.location.hash`, which
  survives `cleanup()` and would leak into the next test's `<App />`
  mount. Mitigation: App.test.tsx's `afterEach` resets
  `window.location.hash = ''`.

### Neutral

- **Bundle size.** react-router-dom (~12KB gzipped) + zustand (~1KB) +
  react-query (~14KB) total ~27KB. The renderer bundle grew from
  ~700KB to 788KB (about 88KB before tree-shaking; net +27KB after
  Terser). Well within the +200KB Phase 5 budget.
- **No IPC contract changes.** Main process is untouched.

## Alternatives considered

- **Tanstack Router.** Rejected: smaller ecosystem, more conceptual
  overhead (file-based routing, code generation step) for a four-route
  tree. react-router's history-driven, JSX-defined routes match our
  needs without tooling additions.
- **Redux Toolkit.** Rejected: enormous mental model (slices,
  reducers, middleware, devtools wiring) for what is, today, three
  tiny stores. Zustand's `create<T>` is the smallest API in the React
  ecosystem that still gives selector-based subscription.
- **Jotai.** Rejected: similar size to zustand but the atom model
  fragments state across many small primitives — better for
  fine-grained derived state than for our coarse "engine status"
  global. Not a strong negative; mostly a coin-flip.
- **SWR.** Rejected: react-query's mutation/invalidation story
  (`useMutation` + `queryClient.invalidateQueries`) is materially
  better for an IPC-heavy app where most actions need to invalidate a
  related read. SWR's mutate-by-key works but is more manual.
- **Inline-everything (status quo).** Rejected: doesn't scale to the
  three follow-on phases on the roadmap.

## Open items

- **PR2 — migrate the remaining IPC calls** to `useQuery` /
  `useMutation`. Audit list (each becomes one query/mutation):
  `settings:getAll`, `settings:set`, `engine:lifecycle`,
  `engine:start`, `engine:stop`, `engine:testConnection`,
  `engine:updateConfig`, `policy:get`, `policy:set`,
  `policy:snapshot`, `policy:resetBreaker`, `diag:export`. Push
  channels (`engine:state`, `engine:log`, `engine:log-record`)
  remain imperative subscribers but route into either zustand
  (`engine:state`) or the query cache (`engine:log-record`) — the
  pattern this PR established for `logs:recent`.
- **PR3 — react-i18next.** Rip out the hand-rolled `i18n.ts` and the
  `t(key)` helper; replace with `useTranslation` + module-augmented
  resource types so `t('totally-fake-key')` is a TS error.
- **PR4 — tailwindcss + shadcn/ui.** Rewrite `index.css` (971 LOC) to
  ~50 LOC of tailwind directives + design tokens; replace the
  `className="btn btn-primary"` style with shadcn primitives.
- **DiagnosticsPanel onToast prop** still exists for backward
  compatibility with the test fixtures. Once those tests are
  migrated to read `useToastStore` directly, drop the prop.

## Migration outcome (PR2)

Phase 5 PR2 (`feat/p5-pr2-data-layer`) completed the audit work
sketched in the "Open items" list. Final tally:

### Channels migrated to react-query

**Reads (5):**

- `logs:recent` → `useQuery` with 1.5s `refetchInterval` (PR1; baseline).
- `engine:lifecycle` → `useQuery` (no `refetchInterval`; push-driven via
  `engine:state` writing to the same cache key).
- `policy:get` → `useQuery` with `staleTime: Infinity` +
  `refetchOnWindowFocus: false` (config rarely changes; explicit
  invalidation is the only refetch trigger so unsaved form edits don't
  get blown away by a focus-driven refetch).
- `policy:snapshot` → `useQuery` with 2s `refetchInterval` (live
  rate-limiter / breaker counters).
- `settings:getAll` → still served by the one-shot
  `useSettingsBootstrap` hook; the form draft lives in zustand. The
  bootstrap hook intentionally stayed imperative because the result
  seeds a zustand store (settings draft) rather than a render-cache
  slot — moving it to `useQuery` would have added a second source of
  truth for the same data.

**Writes (6 mutations):**

- `engine:start` → `useMutation` (toast on success/error; invalidates
  `['engine:lifecycle']`).
- `engine:stop` → `useMutation` (best-effort; `onSettled` flips status
  to idle even on rejection).
- `engine:testConnection` → `useMutation` (`isPending` drives button
  spinner label).
- `engine:updateConfig` → `useMutation` (best-effort hot-reload chained
  from `settings:set` success; failure swallowed silently).
- `settings:set` → `useMutation` (invalidates `['settings:getAll']`).
- `policy:set` → `useMutation` (invalidates both `['policy:get']` and
  `['policy:snapshot']`).
- `policy:resetBreaker` → `useMutation` (invalidates
  `['policy:snapshot']`).
- `diag:export` → `useMutation` (`isPending` drives button disable +
  "Exporting…" label).

### Push subscribers retained (3)

Imperative `window.electron.on(...)` subscribers survived because they
ingest data from a one-way push channel that has no IPC `read`
counterpart. Each one routes into the **same** cache key or zustand
slot as the corresponding `useQuery` so consumers read from a single
source of truth:

- `engine:state` (in `useEngineSubscription`) → writes both
  `useEngineStore.status` (coarse running/idle/error) and
  `queryClient.setQueryData(['engine:lifecycle'], snapshot)` (rich
  payload). PR2 widened this hook from "engine store only" to "engine
  store + cache" so DiagnosticsPanel's `useQuery` cache stays warm
  without an additional IPC roundtrip.
- `engine:state` (in `DiagnosticsPanel`) → also writes the lifecycle
  cache (idempotent with `useEngineSubscription`) and appends to the
  page-local `transitions` `useState`. Kept colocated because tests
  mount `DiagnosticsPanel` without `AppLayout`, so the global
  subscriber wouldn't be wired in jsdom.
- `engine:log` (in `useEngineSubscription`) → writes
  `useEngineStore.lastError` for "engine无法启动"-style failures.
- `engine:log` (in `ControlPage`) → appends to the page-local `logs`
  `useState`.
- `engine:log-record` (in `DiagnosticsPanel`) → writes via
  `setQueryData(['logs:recent', 200], …)` (PR1).

### State-mgmt-via-cache vs page-local `useState`

Two pieces of state stayed in `useState` rather than the react-query
cache:

- **`ControlPage.logs`** — the engine activity log buffer (per-page,
  push-only).
- **`DiagnosticsPanel.transitions`** — the lifecycle transition list
  (per-page, push-only).

Rationale: both are append-only ring buffers fed exclusively by push
events. There is no IPC `read` channel for either; storing them in the
react-query cache would amount to "useState in disguise" with extra
ceremony. They're page-local, never read by another component, and
never need cross-page invalidation. The PR1 cache-as-state pattern
(used for `logs:recent`) earns its keep when there's a corresponding
read channel that benefits from a polling backstop; for pure-push
streams, `useState` is the simpler fit. The plan's PR2 §"Concrete
migration checklist > ControlPage" explicitly leaves this as a judgment
call with both choices acceptable.

### Code shape

- Removed every `useEffect` + `window.electron?.invoke(…)` triplet
  outside `lib/ipc.ts`. The renderer now has **zero** direct
  `electron.invoke` call sites in production code (verifiable via
  `rg "electron\\?\\.invoke|electron\\.invoke" src/renderer/src` —
  hits only the wrapper at `lib/ipc.ts:16` plus test fixtures).
- Removed the `useState({ loading, isExporting, testing, saving })`
  ad-hoc loading flags from `ControlPage`, `SettingsPage`,
  `DiagnosticsPanel`, and `AntiDetectionSettings`. Every
  in-flight indicator now reads off `mutation.isPending`.
- `AntiDetectionSettings` shed its `setInterval`-style snapshot
  refresher entirely; `refetchInterval: 2_000` carries the load. The
  manual `initialConfigRef` was likewise dropped — `serverConfig` (the
  query cache) IS the canonical snapshot, so the Balanced preset reads
  from it directly.
- `AntiDetectionSettings` syncs server config → local form state via
  the React docs' "Adjusting some state when a prop changes"
  render-phase pattern (a second `useState` tracking the last-seen
  serverConfig identity). This avoids the `set-state-in-effect` lint
  while preserving the "wipe form on canonical refresh" behaviour.

### Tests

- All 484 tests continue to pass at PR2 boundary.
- `AntiDetectionSettings.test.tsx` swapped bare `render(...)` for
  `renderWithProviders` so the new `useQuery` calls have a
  QueryClientProvider.
- The "Reset breaker re-fetches the snapshot" test loosened its
  exact-count assertion (`=== 2`) to `≥ 2` because the new 2-second
  `refetchInterval` could occasionally land an extra polling-driven
  call during long test runs. The behavioural contract ("at least
  the initial backfill plus the post-reset refetch") is preserved.
- No test count delta. The migration is purely structural — same
  user-visible behaviour, different internals.
