# ADR-0001: Use Vitest as the test framework

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: testing, infrastructure

## Context

The forked codebase has no automated tests, only four manual CLI smoke scripts under
`src/core/rpa/tests/`. Phase 0 needs a test framework that:

1. Works in both Node (main/preload/core) and DOM (renderer) environments.
2. Plays well with TypeScript and the existing Vite/electron-vite build chain.
3. Has fast watch mode for TDD.
4. Has built-in coverage support without extra Babel/transform dance.

## Decision

Adopt **Vitest** with two test projects:

- `node` project covers `src/main/`, `src/preload/`, `src/core/`.
- `jsdom` project covers `src/renderer/` (React).

Coverage uses V8 provider via `@vitest/coverage-v8`. Path aliases come from
`vite-tsconfig-paths`.

## Consequences

### Positive

- Single tool, single config for all surfaces.
- Native ESM and TS support; no Babel needed.
- Vite ecosystem is already in use (electron-vite).
- Fast.

### Negative

- Vitest does not run Electron itself; renderer tests use jsdom, not the real
  Chromium runtime. End-to-end Electron testing is explicitly out of scope
  (see spec §3.8). Real-device smoke testing remains via existing
  `core/rpa/tests/*.ts` manual scripts.
- Vitest 1.6 is the minimum version; older versions don't support the
  `projects` array shape used here.

### Neutral

- Coverage thresholds are 0 in Phase 0; they will be raised to ≥70% for `core/`
  in Phase 2 onwards as real tests appear.

## Alternatives considered

- **Jest:** mature, well-known, but the TS+Vite+Electron stack works less
  smoothly. Slower, larger config surface.
- **Node built-in `node:test`:** lightest weight, but no UI test environment
  and no DOM matchers. Would need a second tool for renderer tests.
- **Playwright Test:** great for E2E; overkill for unit/integration. We will
  consider it later only if real Electron-runtime tests become necessary.
