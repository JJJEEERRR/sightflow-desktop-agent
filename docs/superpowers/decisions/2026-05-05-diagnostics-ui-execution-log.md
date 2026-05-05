# Diagnostics UI — execution log (2026-05-05)

## Why now

The user asked for a Diagnostics UI immediately after Phase 2 merged. The full
Phase 5 in the foundation spec (router + zustand + i18next + view split + ADR
for state mgmt) is 4–5 days. The user wanted a minimal usable Diagnostics
_today_, so we cut a focused PR that:

- Adds a third view (`'diagnostics'`) alongside `'control'` and `'settings'`,
  driven by the existing single-`useState` view router. No router lib, no
  zustand.
- Wires the renderer to the four IPC channels Phase 1 already exposed:
  `engine:lifecycle`, `logs:recent`, `engine:log-record` (push),
  `engine:state` (push). Nothing new on the main side.
- Drops in an `ErrorBoundary` at `main.tsx` so a renderer crash leaves the
  user with a fallback UI instead of a blank window.

The router/zustand split is still planned for Phase 5 — this PR doesn't
foreclose it.

## Decisions

- **No router** — `view` is still a single `useState<View>` in `App`. Adding
  react-router for one extra view inflated bundle size for zero benefit.
- **No zustand** — log buffer + lifecycle snapshot are local to the
  Diagnostics component. No cross-view state to share.
- **Pure-renderer export** — bundle download uses `URL.createObjectURL` +
  anchor click. We considered an `ipcMain.handle('logs:export', ...)` path
  with the Electron save dialog, but it adds an IPC round trip and surface
  area for a feature most users will hit once. The renderer already has
  every byte of the bundle (logs, snapshot, transitions); just write it.
- **Cap renderer-side log buffer at 500** — independent of the 2000-record
  ring buffer in main. Renderer should stay light; users who want the full
  buffer can hit "Export Bundle" which goes through `logs:recent` for
  backfill anyway.
- **English-locale tests with explicit reset** — the panel reads `t(...)`
  values, and the default locale is `zh`. Tests `setLocale('en')` in
  `beforeAll` and reset to `'zh'` in `afterAll` so they don't leak into
  sibling test files within the same Vitest worker.
- **Drop the clipboard write assertion** — jsdom's `navigator.clipboard`
  is a non-configurable getter on `Navigator.prototype`, so
  `Object.defineProperty(navigator, 'clipboard', ...)` does not actually
  shadow the read. We kept the boundary test but only assert that the Copy
  button doesn't throw and the boundary stays mounted.
- **`scrollTop = scrollHeight` instead of `scrollIntoView`** — jsdom omits
  `scrollIntoView` from `Element.prototype`. The existing `ControlPanel`
  already uses the scrollTop pattern; the diagnostics panel follows suit.

## Module layout

```
src/renderer/src/
  components/
    DiagnosticsPanel.tsx       (new — main UI)
    DiagnosticsPanel.test.tsx  (new — 6 tests)
    ErrorBoundary.tsx          (new — top-level fallback)
    ErrorBoundary.test.tsx     (new — 3 tests)
  types.ts                     (new — renderer mirrors of LogRecord/LifecycleSnapshot)
  App.tsx                      (added 'diagnostics' view + bottom-bar button)
  main.tsx                     (wrap App in ErrorBoundary)
  i18n.ts                      (+22 keys for diag.*, +1 toast.copied)
  index.css                    (~200 lines of diagnostics + boundary styles)
```

## Quality gates

- `npm run lint` — clean
- `npm run typecheck` — clean
- `npm test` — 226 passed (was 217; +9 from this PR)
- `npm run build` — clean (renderer bundle 588 kB, +~10 kB from before)

## Out-of-scope (deferred)

- Per-record JSON viewer (click to expand `data` and `err.stack`)
- Real-time metrics panel (Phase 1 metrics are wired but no IPC channel
  exists to surface counters/histograms to the renderer yet — Phase 4 territory)
- Zustand-backed shared state, react-router, i18next migration — all in
  the original Phase 5 plan
- A "Send diagnostic bundle" upload flow — needs a server endpoint we
  don't own yet
