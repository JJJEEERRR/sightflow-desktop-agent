# ADR-0014: react-i18next instead of the homegrown i18n module

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: frontend, i18n, refactor, phase-5

## Context

Phase 5 PR1 + PR2 modernized the renderer's routing (react-router),
state (zustand), and data layer (react-query). The last bespoke piece
was `src/renderer/src/i18n.ts` — a 274-line module that hand-rolled
two `Record<string, string>` dictionaries (zh + en, ~200 keys), a
module-level `currentLocale` singleton, and a `t(key)` lookup with a
fall-through-to-zh-then-key safety net.

The homegrown module worked, but it had outgrown its design:

- **No interpolation.** A toast like `Diagnostics exported to: ${path}`
  had to concatenate `t(...)` outputs in JS, which means translators
  can't reorder the components for languages where the path comes
  first.
- **No plurals / contexts / namespaces.** Future copy will need at
  least plurals (e.g. retry-in-N-seconds counters).
- **No compile-time key safety.** `t('control.starrt')` was a silent
  string-passthrough at runtime.
- **Cross-tree drift risk.** Adding a key in only one of the two dicts
  was an at-runtime fall-through (legacy `t()` defaulted to zh, then
  the literal key string) — a missing en translation could silently
  ship.

`docs/adr/0013-react-router-zustand-react-query.md` already flagged
this as PR3 in the open-items list ("rip out the hand-rolled `i18n.ts`
and the `t(key)` helper; replace with `useTranslation` + module-augmented
resource types so `t('totally-fake-key')` is a TS error").

## Decision

We adopt **`i18next` + `react-i18next`** (the de-facto standard React
i18n stack), with the following minimal configuration:

1. **Bundled resources, no async load.** Two JSON files
   (`src/renderer/src/locales/zh.json` and `…/en.json`) are statically
   imported by `src/renderer/src/i18n/index.ts`. No `i18next-http-backend`,
   no `i18next-browser-languagedetector`, no Suspense boundary —
   `react.useSuspense: false`. This keeps test setup simple and the
   first-paint cost zero.

2. **Flat keys, no namespace separator, no key separator.** The
   legacy dictionaries used flat strings like `'control.start'` and
   `'control.start.nokey'` as siblings. i18next's default
   `keySeparator: '.'` would treat the latter as a walk through the
   former (which is now a string, not an object). Setting
   `keySeparator: false` and `nsSeparator: false` makes i18next look
   up the key as a single literal — preserving the existing dictionary
   shape with **zero translation key changes**.

3. **No fallback to a different locale (`fallbackLng: false`).** The
   two dicts are paired 1:1 (verified by `i18n.test.ts`). A missing
   key is a real bug; surfacing the literal key string in the UI is
   louder than silently reading from the other locale.

4. **Initial language detection.** `readStoredLocale()` reads from
   `window.localStorage['sightflow.locale']` (same key the legacy
   `setLocale` ended up writing to via the settings UI in earlier
   phases), defaulting to `'zh'` if storage is unset or unavailable
   (jsdom). `setLocale(...)` writes back to `localStorage`.

5. **Compile-time key safety via module augmentation.**
   `src/renderer/src/i18n/types.d.ts` declares
   `interface CustomTypeOptions { resources: { translation: typeof zh }; keySeparator: false; nsSeparator: false }`.
   With this in place, `t('totally-fake-key')` is a TypeScript error
   (verified: typecheck rejects typos). The dynamic-key call in
   `ControlPage.tsx` (rendering one of four `control.log.{type}`
   labels for each log entry) is preserved by introducing a literal-
   typed `LOG_TYPE_KEY` lookup map; this keeps full type safety at the
   call site.

6. **Class-component escape hatch.** `ErrorBoundary` is the one class
   component in the renderer; it can't use the `useTranslation` hook.
   It imports the i18next singleton directly
   (`import i18n from '../i18n'`) and calls `i18n.t(...)` — acceptable
   because the boundary's render path is a hard-error case and doesn't
   need to react to live language changes.

7. **Test setup.** `tests/setup.jsdom.ts` (already wired into the
   `jsdom` vitest project as the only `setupFiles` entry) gains a
   side-effect import of `src/renderer/src/i18n` so every component
   test renders with a translation function ready before any
   `useTranslation()` call. Existing tests' visible-string assertions
   (e.g. `screen.getByText('启动引擎')`) remain unchanged because the
   dictionary contents are unchanged.

### Files

- **New:** `src/renderer/src/locales/zh.json`,
  `src/renderer/src/locales/en.json`,
  `src/renderer/src/i18n/index.ts`,
  `src/renderer/src/i18n/types.d.ts`,
  `src/renderer/src/i18n/i18n.test.ts`.
- **Deleted:** `src/renderer/src/i18n.ts`,
  `src/renderer/src/i18n.test.ts`.
- **Modified:** `src/renderer/src/main.tsx` (side-effect import),
  `tests/setup.jsdom.ts` (side-effect import),
  `src/renderer/src/layout/AppLayout.tsx`,
  `src/renderer/src/pages/ControlPage.tsx`,
  `src/renderer/src/pages/SettingsPage.tsx`,
  `src/renderer/src/components/AntiDetectionSettings.tsx`,
  `src/renderer/src/components/DiagnosticsPanel.tsx`,
  `src/renderer/src/components/ErrorBoundary.tsx`.

## Consequences

### Positive

- **Compile-time key safety.** Typos in `t('...')` keys are caught at
  TypeScript build time, not at QA time.
- **Standard ecosystem.** Translators / future contributors can lean
  on i18next docs and tooling instead of reverse-engineering 274 LOC
  of bespoke code.
- **Future-proofs interpolation, plurals, contexts.** None of these
  are used in PR3 (the legacy dicts have no `{path}` style placeholders),
  but the infrastructure is now in place — adding a `{{count}}` to
  any key is a one-line follow-up.
- **No translation key changes.** Every existing key resolves
  byte-identically to the same string it did before. All 484 tests
  pass without any text-assertion edits.

### Negative

- **+~80 KB to renderer bundle (gzipped).** `i18next` is ~40 KB
  minified, `react-i18next` ~15 KB; gzipped overhead is in the
  ~25–30 KB range. The renderer chunk grew from 851 KB to 887 KB
  (delta ≈ 36 KB un-gzipped). Well within Phase 5's bundle budget.
- **Slightly stricter dev ergonomics.** With `fallbackLng: false`, a
  missing key shows up as the literal key string instead of falling
  back. Intentional — see Decision §3 — but it does require touching
  both dicts whenever a new key is added.

### Neutral

- **Translation values share i18next's `{{var}}` interpolation
  syntax.** Not exercised today (no values in either dict have
  placeholders), but if a future translator writes `{path}` instead
  of `{{path}}` in a value, i18next will render the literal `{path}`.
  Acceptable footgun — the standard syntax is well-documented.
- **New keys live in only one place** — the JSON files. TypeScript
  flags typos at the call site at compile time.

## Alternatives considered

- **`react-intl` (FormatJS).** Heavier (~75 KB), and ICU MessageFormat
  is overkill for an app with no plurals and no formatted-message
  contexts today. Adopting ICU now would be premature optimization.
- **`lingui`.** Excellent i18n library, but its build-step macro
  approach adds Babel/SWC pipeline complexity that the current
  electron-vite + Vite setup doesn't carry. Not worth the integration
  cost for a two-locale app.
- **Status quo (homegrown `i18n.ts`).** Rejected — see Context.
  Continuing to maintain a custom string lookup with no key safety,
  no interpolation, and no path to plurals would be a slow drag on
  every future copy change.
- **`@formatjs/intl` core only (no React bindings).** Strictly worse
  than `react-i18next` for our use case; we'd be hand-rolling the
  React integration that `react-i18next` already battle-tests.

## Open items

- **PR4 — tailwindcss + shadcn/ui.** Still pending per the Phase 5
  plan. PR3 made no changes to `index.css`; the hand-written class
  names continue to be referenced exactly as before.
- **Adding a new locale.** Drop `src/renderer/src/locales/<lang>.json`
  with all keys present, register it in `i18n/index.ts`'s `resources`
  block, and add a UI affordance to call `setLocale('<lang>')`. The
  type augmentation in `types.d.ts` keys off the zh dictionary, so it
  needs no changes when adding additional locales (zh remains the
  canonical key set).
- **Migrating plain JS-side string concatenation to interpolation.**
  Several call sites still write `${t('diag.export.success')}: ${path}`.
  These work, but a future cleanup pass could move them to keys like
  `"diag.export.success": "Diagnostics exported to: {{path}}"` and
  call `t('diag.export.success', { path })`. Out of scope for PR3 —
  the goal here is a clean library swap, not a copy refactor.
