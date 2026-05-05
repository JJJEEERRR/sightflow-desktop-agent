# 0004 — Tighten TypeScript strictness: ban `any` and require explicit return types

- **Status:** Accepted
- **Date:** 2026-05-05
- **Deciders:** Phase 0 follow-up cleanup (`chore/lint-debt-cleanup`)
- **Supersedes:** Soft `'warn'` settings introduced in PR #1 / Phase 0

## Context

Phase 0 landed the engineering baseline (lint, typecheck, CI, tests, hooks)
on top of the original demo codebase, which carried 85 pre-existing lint
warnings:

- 51 × `@typescript-eslint/no-explicit-any`
- 34 × `@typescript-eslint/explicit-function-return-type`

To unblock CI we temporarily demoted both rules from `error` to `warn`
(see `eslint.config.mjs` history and `docs/adr/0001-...`). Phase 1 will
introduce a much larger surface (anti-detect, supervisor, observability,
Hooks abstraction) and we want to enter Phase 1 with a strict, opinionated
type system rather than accumulate more debt.

## Decision

Re-tighten the rules to `error` after clearing all 85 baseline warnings.
Specifically:

- `@typescript-eslint/no-explicit-any: 'error'` — every `any` in the
  codebase has been replaced with a concrete type, a discriminated union,
  `unknown` + narrowing, or a minimally-typed library facade
  (e.g. `Robot`, `NodeWindow`, `ChatMessage`, `IpcResult`).
- `@typescript-eslint/explicit-function-return-type` is set to `error`
  with `allowExpressions / allowTypedFunctionExpressions / allowHigherOrderFunctions`
  so that inline callbacks and JSX event handlers are still ergonomic, but
  every standalone function and class method must declare its return type.

The pre-commit `lint-staged` hook continues to run ESLint on staged files,
so violations now block commit locally — not just on CI.

## Consequences

- Future PRs cannot regress: any new `any` or missing return type fails
  pre-commit and CI.
- IPC payloads now flow through a typed `ElectronHandler.invoke<T>()` shape;
  renderer call sites must specify the expected return type, which doubles
  as live documentation of the IPC contract.
- A few discriminated-union return shapes (`CaptureResult`, `IpcResult`)
  required call sites to split `if (!ok || !field)` into two checks so
  TypeScript can narrow correctly. Pattern is now consistent across the
  codebase.
- Side-effect: a previously latent i18n bug surfaced —
  `'settings.baseURL.hint'` was referenced but not defined, so the UI was
  rendering the literal key. Added the missing translations in zh + en.

## Alternatives considered

1. **Leave rules as `warn` indefinitely.** Rejected — `warn` rapidly
   becomes invisible noise; the soft baseline would calcify and the
   strictness ratchet would never happen.
2. **Use `as any` casts to clear warnings without real fixes.** Rejected —
   defeats the purpose; the cleanup should also surface latent bugs.
3. **Keep `explicit-function-return-type` as `warn`.** Rejected — the rule
   catches a real class of regressions (unintended `Promise<void>`
   inference, accidentally-throwing functions returning `never`).

## References

- `eslint.config.mjs` — final rule configuration
- `docs/adr/0001-use-vitest-for-testing.md`
- `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md` —
  Section "Quality Gates"
