# ADR-0015: Tailwind v3 + shadcn/ui design system

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: frontend, design-system, refactor, phase-5

## Context

Phase 5 PR1–PR3 modernized the renderer's routing (react-router),
state (zustand), data layer (react-query), and i18n (react-i18next).
The last bespoke piece of the renderer was its CSS: `index.css` had
grown to **971 hand-written lines** of class-by-class rules for every
visible surface — `.btn`, `.bottom-btn`, `.bottom-btn-play`,
`.bottom-btn-settings.active`, `.card`, `.card-title`, `.policy-card`,
`.policy-checkbox-label`, `.policy-range-row`, `.diag-card`, `.diag-row`,
`.diag-state-pill.running`, `.toast.show`, etc. Every new component
landed yet another bespoke selector. There were no design tokens
beyond a handful of `--bg-*` / `--accent` CSS vars at the top, no
constraint on padding/spacing/radius, and no shared variant system.

Adding a new control meant: pick a slightly different padding, pick
a slightly different border-radius, pick a slightly different shade of
glass, and ship — until the renderer drifted into ten variants of
"approximately the same". The diagnostic and anti-detection panels
already had ~150 lines each of one-off rules.

`docs/adr/0013-react-router-zustand-react-query.md` flagged this as
**PR4** in the open-items list ("rewrite `index.css` (971 LOC) to ~50
LOC of tailwind directives + design tokens; replace the
`className="btn btn-primary"` style with shadcn primitives").

## Decision

We adopt **Tailwind CSS v3** + **shadcn/ui** copy-in components, with
the following minimal configuration:

1. **Tailwind v3, not v4.** v3 is the version every shadcn/ui recipe
   targets; v4's CSS-first config breaks shadcn's existing recipes and
   the wider ecosystem hasn't caught up. Pin `tailwindcss@^3.4`. We can
   migrate to v4 in a future PR once the recipe book stabilizes.

2. **shadcn/ui primitives are vendored, not installed.** There is no
   npm package called `shadcn/ui` — the project is "copy components into
   your codebase, you own them". `npx shadcn@latest add button input
card switch slider label textarea` initialised
   `components.json` and wrote the primitives into
   `src/renderer/src/components/ui/`. Each primitive is a thin Tailwind
   wrapper around a Radix UI peer (Switch, Slider, Label) or a vanilla
   `forwardRef` (Button, Input, Card, Textarea). Future copy-ins land
   in the same directory.

3. **Design tokens are HSL CSS variables.** `:root` in `index.css`
   declares `--background`, `--foreground`, `--primary`, `--accent`,
   `--card`, `--border`, `--ring`, `--destructive`, `--warning`,
   `--radius`, etc. — the standard shadcn token set, with values
   derived from the legacy `--accent #10b981`, `--bg-primary #0a0b10`,
   `--text-primary #f0f0f5`, `--error #f87171` palette so visual fidelity
   is preserved. `tailwind.config.ts` exposes them under `theme.extend.colors`
   as `hsl(var(--background))` etc., which is what the shadcn primitives
   reference.

4. **`darkMode: ['class']` reserved for the future.** The app is
   dark-only today; the `:root` token block IS the dark palette.
   `.dark { color-scheme: dark; }` is wired but otherwise empty so a
   future light-mode toggle is a one-place change. Out of scope for this
   PR.

5. **`cn(...)` helper for class composition.** `lib/utils.ts` exports
   `cn = (...inputs) => twMerge(clsx(inputs))`. Every primitive in
   `components/ui/` and every page-level conditional className uses it
   so a caller-supplied `className` overrides the primitive's defaults
   without specificity battles.

6. **Animations.** `tailwind.config.ts` registers three keyframes —
   `pulse-dot` (header status indicator), `fade-in` (ControlPage),
   `slide-up` (other pages) — preserving the legacy entry animations.
   The `tailwindcss-animate` plugin pulls in the additional Radix-driven
   animation utilities (e.g. `data-[state=open]:animate-in`) that the
   shadcn primitives reference.

7. **Body-level decorations.** Two visual elements have no Tailwind
   equivalent and stay as raw CSS at the bottom of `index.css`:
   - `body::before` / `body::after` — the ambient green + purple
     gradient blobs the legacy `.app::before/::after` rendered. Moved
     to `body::*` so the AppLayout root can stay token-driven.
   - `::-webkit-scrollbar*` — the thin (4px) translucent scrollbar.
   - `.drag-region` / `.no-drag` — Electron `-webkit-app-region` flags
     that have no Tailwind utility analog. Declared in `@layer
utilities` so they tree-shake out if unused.

### File changes

- **New:**
  - `tailwind.config.ts`
  - `postcss.config.cjs`
  - `components.json` (shadcn CLI config; `aliases` point to
    `@renderer/components/ui` so future `npx shadcn add <component>`
    runs land in the right directory)
  - `src/renderer/src/lib/utils.ts` (`cn()` helper)
  - `src/renderer/src/components/ui/{button,card,input,label,slider,switch,textarea}.tsx`
  - `docs/adr/0015-tailwind-shadcn-design-system.md` (this file)
- **Rewritten:**
  - `src/renderer/src/index.css` — 971 LOC → 94 LOC (`@tailwind`
    directives + token block + body decorations + `@layer utilities`).
- **Modified (className sweep):**
  - `src/renderer/src/layout/AppLayout.tsx`
  - `src/renderer/src/pages/ControlPage.tsx`
  - `src/renderer/src/pages/SettingsPage.tsx`
  - `src/renderer/src/components/AntiDetectionSettings.tsx`
  - `src/renderer/src/components/DiagnosticsPanel.tsx`
  - `src/renderer/src/components/ErrorBoundary.tsx`
- **Modified (test-selector sweep):**
  - `src/renderer/src/App.test.tsx` — `.bottom-btn-start` → `getByTestId('control-start')`,
    `.toast.show` → `queryByTestId('toast')`.
  - `src/renderer/src/components/DiagnosticsPanel.test.tsx` —
    `.diag-transition .diag-state-pill` → `getAllByTestId('diag-state-pill')`.
- **Modified (config):**
  - `package.json` — `tailwindcss`, `postcss`, `autoprefixer`,
    `tailwindcss-animate`, `class-variance-authority`, `clsx`,
    `tailwind-merge`, `@radix-ui/react-{slot,switch,slider,label}`.
  - `eslint.config.mjs` — relaxes `react/prop-types` and
    `react-refresh/only-export-components` for
    `src/renderer/src/components/ui/**` so the vendored shadcn files
    stay byte-identical to upstream recipes.

### Token mapping

Every legacy `index.css` colour was extracted and re-expressed as an
HSL token. `body::before` keeps its `rgb(168 85 247 / 0.06)` purple
literal because the renderer has no other use of that hue and adding a
one-off token would be churn.

| Legacy var (index.css)  | Hex     | New shadcn token       | HSL value   |
| ----------------------- | ------- | ---------------------- | ----------- |
| `--bg-primary`          | #0a0b10 | `--background`         | 228 24% 5%  |
| `--text-primary`        | #f0f0f5 | `--foreground`         | 240 20% 95% |
| `--bg-glass` (~)        | …       | `--card`               | 240 8% 10%  |
| `--text-secondary`      | #8a8aa0 | `--muted-foreground`   | 240 11% 58% |
| `--accent`              | #10b981 | `--primary` / `--ring` | 160 84% 39% |
| (button text on accent) | #000    | `--primary-foreground` | 0 0% 0%     |
| `--bg-glass-heavy`      | …       | `--secondary`          | 240 6% 12%  |
| `--accent-subtle`       | …       | `--accent`             | 160 84% 16% |
| `--error`               | #f87171 | `--destructive`        | 0 91% 71%   |
| `--warning`             | #fbbf24 | `--warning`            | 45 96% 56%  |
| `--glass-border`        | …       | `--border` / `--input` | 240 6% 16%  |
| `--radius-md` 12px      | —       | `--radius`             | 0.75rem     |

## Consequences

### Positive

- **`index.css` 971 → 94 LOC** (90% reduction). Every other styling
  decision is now a Tailwind utility on JSX, a shadcn variant in
  `components/ui/*`, or a token in the `:root` block.
- **Consistent design vocabulary.** Spacing, radius, font size, colour
  all flow from the token set + Tailwind scale. New components can
  only paint with the colours that exist; arbitrary `padding: 9px 11px`
  becomes `px-3 py-2` (or arbitrary `px-[11px]` only when truly needed).
- **Accessible by default.** `<Switch>`, `<Slider>`, `<Label>` are
  Radix primitives — `role="switch"`, `aria-valuemin/max`, `htmlFor`
  bindings come for free. The legacy `<input type="checkbox">` toggles
  did the same accidentally; the migrated `<Switch>` makes it explicit.
- **We OWN the shadcn components.** They're plain TSX in our repo with
  no upstream version pin to track. Customising one (e.g. tweaking
  `Card`'s default padding) is a local edit, not a fork.
- **Tree-shaken CSS.** Tailwind's JIT pass scans
  `./index.html` and `./src/renderer/**/*.{ts,tsx}` and emits only
  utilities actually referenced. The renderer CSS chunk is 35.6 KB
  un-gzipped — comparable to the hand-written stylesheet it replaces.

### Negative

- **+~119 KB to renderer JS bundle (un-gzipped).** Radix primitives
  - class-variance-authority + tailwind-merge add roughly that much.
    The renderer chunk grew from 887 KB (post-PR3) to 1,006 KB. Within
    the +200 KB Phase 5 budget. Most of the growth is Radix UI
    (Switch + Slider + Label combine to ~50 KB un-gzipped); the rest is
    cva + tailwind-merge + clsx.
- **Some bespoke arbitrary-value classes.** The big start/stop button in
  ControlPage uses `bg-gradient-to-br from-primary to-[hsl(160_84%_31%)]`
  - a hand-written `shadow-[…]` to reproduce the legacy gradient + glow.
    That's ~10 lines of arbitrary values per button variant. Acceptable as
    a one-off; a future PR could promote `shadow-button-primary` etc.
    into the Tailwind config to hide the literals.
- **Class component escape hatch.** `ErrorBoundary` (the one class
  component in the renderer) deliberately uses raw Tailwind utility
  classes on `<div>` / `<button>` instead of the shadcn `<Card>` /
  `<Button>` primitives. The boundary must keep working even when the
  React subtree producing those primitives is exactly what crashed.
  `<div>` + `<button>` can't fail to render.

### Neutral

- **`<input type="checkbox">` retained** in `AntiDetectionSettings`
  rather than swapped for shadcn's `<Switch>`. The existing tests
  assert on `.checked` of a checkbox element by `data-testid`; a
  preemptive swap to `<Switch>` would be a DOM change orthogonal to
  PR4's "visual fidelity, not redesign" scope. The native checkbox
  inherits the new theme via `accent-color: hsl(var(--primary))` (the
  Tailwind `accent-primary` utility). Future ergonomic refactor: swap
  for `<Switch>` and update the affected tests' selectors.
- **No light-theme toggle.** App stays dark-only; all tokens live on
  `:root`. Adding a light theme is a one-place change (mirror the token
  block under `.dark` for dark, repurpose `:root` for light).

## Alternatives considered

- **Tailwind v4.** Rejected: still settling. v4's CSS-first config
  doesn't compose with shadcn's recipe book yet. We adopt v4 in a
  future PR once the upstream recipes catch up.
- **MUI / Chakra UI / Mantine.** Rejected: heavier (each is ~150–300 KB
  un-gzipped), opinionated visual identity that doesn't match the
  glass / dark / emerald-accent feel, and they invert the ownership
  model (the lib owns the components, you fight its theming). shadcn's
  copy-in pattern keeps the components in our repo.
- **Stitches / Vanilla Extract.** Rejected: each adds a build step and
  a different mental model (CSS-in-JS vs utility classes). Tailwind is
  the lower-friction path with a larger talent pool.
- **Status quo (continue hand-writing CSS).** Rejected — see Context.
  971 lines was already past the point where adding a component meant
  inventing yet another set of bespoke class names.

## Open items

- **Phase 5 closure retrospective.** The 4-PR sequence (PR1 routing /
  state / data → PR2 IPC migration → PR3 i18n → PR4 design system) is
  done. Future renderer phases can proceed on top of the modern
  foundation without touching it.
- **Light theme toggle.** Mirror the `:root` token block under
  `.dark` (or create a light-mode `:root` and move the current values
  to `.dark`), wire `<html className={isLight ? '' : 'dark'}>` into
  AppLayout, and surface a switch in SettingsPage. ~30 LOC.
- **Promote arbitrary-value shadows / gradients to tokens.** The
  ControlPage start/stop button uses ~10 lines of `shadow-[…]` and
  `from-[…] to-[…]` literals. Lift them into
  `tailwind.config.ts`'s `theme.extend.boxShadow` / `theme.extend.backgroundImage`
  so the button JSX can read `shadow-button-primary` /
  `bg-button-primary-gradient`.
- **Swap remaining `<input type="checkbox">` → `<Switch>`.** PR4 left
  them native to keep the test-suite stable. A follow-up could migrate
  the toggles to the shadcn primitive (consistent with the Radix-backed
  switch already used elsewhere in the policy form) and update
  `data-testid="X-enabled"` selectors to query by `role="switch"`.
- **Tabs primitive.** The plan listed `tabs.tsx` as a candidate; we
  didn't add it because nothing in the current renderer uses tabbed
  navigation. It can be copied in via `npx shadcn@latest add tabs` the
  day a tab-driven view (e.g. settings categorisation) lands.
