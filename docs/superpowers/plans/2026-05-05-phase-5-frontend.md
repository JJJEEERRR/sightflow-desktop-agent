# Phase 5 — Frontend Deep Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan PR-by-PR. Each PR is dispatched to a fresh subagent.

**Goal:** Modernize the renderer from "single-component + custom-everything" to a maintainable foundation suitable for sustained feature development.

**Architecture:** 4 sequential PRs against `main`. Each PR keeps the user-visible UI functionally identical (same screens, same actions, same toast text). Internal architecture progressively replaces custom code with industry-standard libraries.

**Tech Stack additions:** `react-router-dom`, `zustand`, `@tanstack/react-query`, `react-i18next` + `i18next`, `tailwindcss`, `@radix-ui/react-*` (via shadcn/ui copy-in pattern).

**Constraints:**

- No user-visible visual regression in PR1–PR3 (the design system rewrite in PR4 is allowed visual deltas but should target "equivalent" not "redesigned").
- All tests stay green at every PR boundary (484 → ≥484 going in; allow growth, not shrinkage).
- Zero IPC contract changes. The main process API surface is a hard interface boundary.
- Each PR must be mergeable on its own — no "PR2 needed for PR1 to compile" cross-coupling.

---

## Current state (baseline)

| Concern | Today                                                    | Pain                                         |
| ------- | -------------------------------------------------------- | -------------------------------------------- |
| Routing | `useState<View>` + `if`-cascades in `App.tsx:215+`       | No deep links, no history, no shared layout  |
| State   | `useState` walls in `App.tsx`, props-drilled to children | Re-renders, hard to add cross-page state     |
| IPC     | `useEffect` + `window.electron.invoke` inline            | Manual loading/error/refetch/cache, no dedup |
| i18n    | `i18n.ts:t(key)` hand-rolled, flat zh/en records         | No interpolation, no plurals, no async load  |
| CSS     | `index.css` 971 lines hand-written                       | No design tokens, no theme, hard to extend   |
| Forms   | `AntiDetectionSettings.tsx` 714 LOC manual `onChange`    | Duplicated boilerplate, no shared validation |

Test count baseline: **484 passing across 36 files**.

---

## File inventory (renderer scope)

| File                                                    | Lines  | PR1                                     | PR2                                  | PR3                      | PR4                   |
| ------------------------------------------------------- | ------ | --------------------------------------- | ------------------------------------ | ------------------------ | --------------------- |
| `src/renderer/src/App.tsx`                              | 487    | major (→ Layout + 4 page files)         | minor                                | string sweep             | className sweep       |
| `src/renderer/src/main.tsx`                             | 8      | wrap providers                          | —                                    | wrap I18nextProvider     | —                     |
| `src/renderer/src/i18n.ts`                              | 274    | —                                       | —                                    | full rewrite             | —                     |
| `src/renderer/src/index.css`                            | 971    | —                                       | —                                    | —                        | full rewrite          |
| `src/renderer/src/components/AntiDetectionSettings.tsx` | 714    | extract to `pages/AntiDetectionPage`    | useQuery for snapshot                | string sweep             | className sweep       |
| `src/renderer/src/components/DiagnosticsPanel.tsx`      | 348    | extract to `pages/DiagnosticsPage`      | useQuery for logs:recent + lifecycle | string sweep             | className sweep       |
| `src/renderer/src/components/ErrorBoundary.tsx`         | 92     | —                                       | —                                    | —                        | small className tweak |
| `src/renderer/src/components/*.test.tsx`                | varies | wrap MemoryRouter + QueryClientProvider | grow                                 | I18nextProvider in setup | minor selectors       |
| `src/renderer/src/types.ts`                             | 35     | —                                       | —                                    | —                        | —                     |

---

## PR1 — Foundation: Routing + State + Data layer

**Branch:** `feat/p5-pr1-foundation`

### Scope

1. **Add deps:** `react-router-dom`, `zustand`, `@tanstack/react-query`. No `@types/*` needed (all ship types).
2. **Create stores** (zustand):
   - `src/renderer/src/stores/engine.ts` — `{ status: EngineStatus; lastError: string | null; setStatus; setLastError; reset }`
   - `src/renderer/src/stores/settings.ts` — settings draft (apiKey, model, baseURL, systemPrompt, appType) + dirty flag + load/save/reset actions
   - `src/renderer/src/stores/toast.ts` — toast queue + push + dismiss
3. **Create QueryClient** in `src/renderer/src/lib/query-client.ts` with sensible defaults (`refetchOnWindowFocus: false` because it's an Electron app, `staleTime: 5_000` for IPC reads).
4. **IPC client wrapper** in `src/renderer/src/lib/ipc.ts` — typed `invoke<TResult>(channel, payload?)` that wraps `window.electron?.invoke` with a defensive null check (test fixture might not install it). One source of truth for IPC types.
5. **Routes** in `src/renderer/src/routes.tsx` — `<HashRouter>` (Electron file:// works better with hash routing) with paths:
   - `/` — `<ControlPage>`
   - `/settings` — `<SettingsPage>`
   - `/diagnostics` — `<DiagnosticsPage>`
   - `/anti-detection` — `<AntiDetectionPage>`
6. **Page extraction** — split `App.tsx` into:
   - `src/renderer/src/pages/ControlPage.tsx` — start/stop button, log viewer, app type selector
   - `src/renderer/src/pages/SettingsPage.tsx` — apiKey, model, baseURL, systemPrompt + Test connection
   - `src/renderer/src/pages/DiagnosticsPage.tsx` — wraps existing `DiagnosticsPanel`
   - `src/renderer/src/pages/AntiDetectionPage.tsx` — wraps existing `AntiDetectionSettings`
7. **Layout** — `src/renderer/src/layout/AppLayout.tsx` with header (title + status pill) and bottom nav. Bottom nav uses `<NavLink>`s.
8. **Slim `App.tsx`** to ~30 lines: `<QueryClientProvider><HashRouter><AppLayout><Routes>...</Routes></AppLayout></HashRouter></QueryClientProvider>` plus the toast outlet.
9. **Migrate ONE IPC call to react-query** as proof: `useQuery({ queryKey: ['logs:recent'], queryFn: () => ipc.invoke<LogRecord[]>('logs:recent', 200), refetchInterval: 1500 })` in DiagnosticsPanel. Other IPC calls keep their existing useEffect pattern in this PR (they migrate in PR2).
10. **Update tests** — `App.test.tsx` and any component tests that mount components: wrap renders in `<QueryClientProvider>` + `<MemoryRouter initialEntries={['/']}>` (or `<HashRouter>`). Add a small `test-utils.tsx` exporting `renderWithProviders`. All 484 tests must still pass.
11. **ADR-0013** documenting the choice of router/state/data libs.

### Acceptance criteria

- [ ] `npm run build` clean
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npx vitest run` — ≥ 484 passing (some grow, none shrink)
- [ ] Manual smoke (subagent describes mentally): clicking the bottom nav between Control / Settings / Diagnostics / Anti-Detection routes works; deep linking via URL hash works; refreshing keeps you on the same page.
- [ ] `App.tsx` ≤ 60 lines.
- [ ] No new `useState` for global state; engine status / toast are in zustand.

### Out of scope

- Migrating other IPC calls (PR2)
- Replacing the i18n.ts file (PR3)
- Touching index.css beyond layout shifts caused by routing (PR4 does the rewrite)

---

## PR2 — Data layer migration: All IPC → react-query, all global state → zustand

**Branch:** `feat/p5-pr2-data-layer`

### Scope

1. **Audit** every `window.electron?.invoke(...)` call site in the renderer. Migrate each:
   - **Read** (returns data, possibly polled) → `useQuery({ queryKey: [channel, ...args], queryFn: () => ipc.invoke(channel, ...args) })`
   - **Write** (mutation, e.g. `policy:set`, `engine:start`, `engine:stop`, `settings:set`) → `useMutation({ mutationFn: (vars) => ipc.invoke(channel, vars), onSuccess: () => queryClient.invalidateQueries(...) })`
2. **Push channels** (the `window.electron?.on('engine:state', ...)` pattern) — keep them as imperative subscribers but route their payloads into either a zustand setter OR `queryClient.setQueryData([...], ...)` so the rest of the app reads from one source.
3. **Remove `useEffect` + `useState({loading, error, data})` triplets** — react-query owns loading/error.
4. **Pin all global state to zustand stores** (already created in PR1; expand them as needed).
5. **Test wiring** — provide a fresh `QueryClient` per test (don't share across tests; cache pollution would mask bugs). Add a `mockInvoke({ channel, response })` helper in `test-utils.tsx`.
6. **Doc:** update ADR-0013 with the migration outcome (X channels migrated, Y push subscribers remaining, Z lines of useEffect removed).

### Acceptance criteria

- [ ] Zero `useEffect` + `invoke` patterns remain in renderer (`grep -r 'invoke(' src/renderer/src` should only show the inside of query/mutation functions or push subscribers).
- [ ] `npm run build / lint / typecheck / test` all clean. ≥ 484 passing.
- [ ] DiagnosticsPanel's polling logic is now driven by `refetchInterval`, not custom timer.
- [ ] AntiDetectionSettings reads `policy:snapshot` via `useQuery`, writes via `useMutation`, and re-renders correctly after a save.

### Out of scope

- i18n migration (PR3)
- CSS rewrite (PR4)
- IPC contract changes (would break main; not in scope ever for this phase)

---

## PR3 — i18n migration: react-i18next

**Branch:** `feat/p5-pr3-i18next`

### Scope

1. **Add deps:** `i18next`, `react-i18next`. No `@types` needed.
2. **Create resource files**:
   - `src/renderer/src/locales/zh/translation.json` — flatten current `i18n.ts` zh dict
   - `src/renderer/src/locales/en/translation.json` — same for en
3. **i18n init module:** `src/renderer/src/i18n/index.ts` — `i18n.use(initReactI18next).init({ resources, lng: 'zh', fallbackLng: 'en', interpolation: { escapeValue: false } })`. Read initial language from settings (or default zh).
4. **Wrap `<App />`** in `<I18nextProvider>` in `main.tsx`.
5. **Replace every `t('key')` call site** with `useTranslation()` + `t('key')` from react-i18next. Where possible, use string interpolation: e.g.
   - `Diagnostics exported to: ${path}` → `t('diag.export.success', { path })` with resource `"diag.export.success": "Diagnostics exported to: {{path}}"`.
   - Audit string concatenations done in JS (e.g. `${t('diag.export.success')}: ${result.path}`) and migrate to interpolation where it cleans up the call site.
6. **Type safety:** add `src/renderer/src/i18n/types.d.ts` with module augmentation for `react-i18next` so `t('foo.bar')` is type-checked against the resource keys (TypeScript's "type-safe i18n" pattern: `declare module 'react-i18next' { interface CustomTypeOptions { resources: typeof zhResources } }`).
7. **Delete or stub** the old `src/renderer/src/i18n.ts` — for compatibility, leave a thin re-export of `t` that delegates to `i18next.t` so any forgotten import sites don't break.
8. **Test setup:** test renders need to import `'src/renderer/src/i18n'` (which initializes i18next) before the components. Or provide a test wrapper that wraps in `<I18nextProvider>`.
9. **Update `i18n.test.ts`** to test against the new translation function (it currently tests the custom `t`; should now test resource coverage and key resolution).
10. **ADR-0014** documenting the i18n migration and the type-augmentation pattern.

### Acceptance criteria

- [ ] All 484+ tests still pass.
- [ ] `grep -r "from './i18n'" src/renderer/src` → 0 hits to the old file (or only re-exports).
- [ ] `useTranslation()` is used in every component that displays text.
- [ ] At least 3 strings now use interpolation (e.g. the `diag.export.success` path interpolation, retry-in-N-seconds counters, count-pluralized fields).
- [ ] Type augmentation works: `t('totally-fake-key')` produces a TypeScript error.

### Out of scope

- Adding new languages (the i18next infrastructure supports it; user can add ja/etc. later by dropping in a new resource file).
- CSS rewrite (PR4).

---

## PR4 — Design system: tailwindcss + shadcn/ui

**Branch:** `feat/p5-pr4-design-system`

### Scope

1. **Add deps:** `tailwindcss`, `@tailwindcss/postcss`, `postcss`, `autoprefixer`, `clsx`, `tailwind-merge`, `class-variance-authority`. Plus shadcn-ui's runtime deps: `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-tabs`, `@radix-ui/react-switch`, `@radix-ui/react-slider`, `@radix-ui/react-toast`, `lucide-react` (icons).
2. **Initialize tailwind:** add `tailwind.config.ts`, `postcss.config.js`, replace `src/renderer/src/index.css` with a tailwind directives file plus a small `@layer base { ... }` block for global resets.
3. **Design tokens:** translate the current visual identity (dark theme, blueish accents, ~16px scale) into a token system in `tailwind.config.ts`'s `theme.extend`. Goal: the new app should look ≥ 85% similar to the current one. Don't redesign UX in this PR.
4. **Shadcn copy-in components** under `src/renderer/src/components/ui/`:
   - `button.tsx`, `card.tsx`, `input.tsx`, `label.tsx`, `slider.tsx`, `switch.tsx`, `tabs.tsx`, `toast.tsx`, `tooltip.tsx`, `dialog.tsx`, `select.tsx` (subset actually used; don't pull what isn't needed).
5. **Migrate every component** in `src/renderer/src/{layout,pages,components}` from `className="btn btn-primary"`-style hand-written classes to tailwind utility classes + shadcn primitives. Focus areas:
   - Bottom nav → tailwind flex
   - Buttons → `<Button variant=…>`
   - Settings inputs → `<Input>`, `<Label>`, `<Switch>`
   - Anti-detection sliders → `<Slider>`
   - Toast → `<Toaster>` + `toast.push` action
   - Cards → `<Card>` with `<CardHeader>` / `<CardContent>`
6. **Delete** the old hand-written CSS class definitions from `index.css`. The final file should be ~50 lines of tailwind directives + `@layer base` resets.
7. **Visual smoke pass:** subagent compares before/after by description (since they can't see screenshots). Where a known-difference exists (e.g. shadow values, border-radius), call it out in the PR body.
8. **ADR-0015** documenting the design-system choice (tailwind+shadcn vs alternatives) and the token system.

### Acceptance criteria

- [ ] `index.css` ≤ 80 lines.
- [ ] No `.btn-primary`, `.card-title`, etc. custom classes remain (`grep -r "className=\"btn" src/renderer/src` → 0 hits).
- [ ] All 484+ tests pass. Where tests asserted DOM structure that shadcn changed (e.g. an `<input type="checkbox">` becoming a Radix `<Switch>` with different DOM), update the selectors to use `getByRole('switch', { name })` style accessible-name queries — that's actually the correct way and was a latent test smell.
- [ ] `npm run build` clean. Bundle size delta ≤ +200KB (shadcn is ~50KB gzipped + tailwind runtime is ~10KB; we're replacing ~30KB of CSS, so net should be small).

### Out of scope

- Visual redesign (UX changes that aren't 1:1 with current behavior). Document any unavoidable visual deltas in PR body.
- Dark/light mode toggle. The app is dark-only today; can be added in a follow-up by extending the tailwind tokens.

---

## Cross-PR risks & mitigations

| Risk                                                                             | Mitigation                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Test-fixture explosion (every test needs router + query client)                  | Centralize in `test-utils.tsx` `renderWithProviders` helper in PR1                                      |
| react-query's `staleTime` masking IPC errors during tests                        | Use `gcTime: 0, staleTime: 0, retry: false` in test QueryClient                                         |
| `useTranslation` requiring suspense or async loading breaks tests                | Initialize i18next synchronously in test setup; don't use language detector                             |
| shadcn components having different DOM than hand-rolled ones (selector breakage) | Migrate test queries to accessible-name queries (`getByRole`) preemptively in PR1 prep where reasonable |
| Bundle size growth                                                               | Verify with `npm run build` after each PR; tree-shaking should keep things tight                        |

---

## Self-review

**Spec coverage:**

- ✅ Router → PR1
- ✅ State management → PR1 + PR2
- ✅ Data layer (IPC) → PR1 (1 channel) + PR2 (rest)
- ✅ i18n → PR3
- ✅ Design system → PR4

**Type consistency:** `EngineStatus`, `AppKind`, `LogRecord`, `LifecycleSnapshot` are all already defined in `src/renderer/src/types.ts`. All PRs reuse those names — no rename needed.

**Placeholder scan:** None. Every PR has concrete acceptance criteria.

---

## Execution

**Mode:** Subagent-Driven Development (per the user's earlier `/subagent-driven-development` directive in this session). Sequential dispatch — each PR depends on the previous, and they all touch overlapping renderer files.

After each PR merges:

1. Sanity-check on `main` that tests + build are green.
2. Update todos.
3. Move to the next PR.
