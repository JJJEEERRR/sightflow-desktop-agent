# Phase 3 Anti-Detection Execution Log

**Date:** 2026-05-05
**Branch:** `feat/phase-3-anti-detection`
**Approach:** Subagent-driven, four parallel implementers + controller integration

## Goal

Implement the Phase-3 anti-detection middleware: humanization, rate limiting, schedule windows, and circuit breaking, combined behind a thin Policy class consumed by the Engine at three hooks (`beforeReply` / `beforeAction` / `afterAction` plus `observe`). Wire it through `main/index.ts` with zod-validated config persistence and IPC handlers.

## Process

1. **Plan** — wrote `docs/superpowers/plans/2026-05-05-phase3-anti-detection.md` with locked module APIs, default config values, file map, and a Wave-1 / Wave-2 execution split.
2. **Schema first** — controller wrote `src/core/policy/config.ts` (zod) so all four parallel agents could import a shared type contract.
3. **Wave 1: 4 parallel implementer subagents** dispatched simultaneously, one per module:
   - Agent A — Humanizer
   - Agent B — RateLimiter
   - Agent C — Schedule
   - Agent D — CircuitBreaker
4. **Wave 2: controller-only integration** (sequential because everything touched shared files):
   - Policy combinator
   - Engine `beforeReply` / `beforeAction` / `afterAction` / `observe` integration
   - `main/index.ts` wiring + 4 new IPC handlers
   - 4 new engine-level integration tests

## Subagent results

| Agent | Module         | Status                                                 | Tests   | LOC (prod / test) |
| ----- | -------------- | ------------------------------------------------------ | ------- | ----------------- |
| A     | Humanizer      | ✅ DONE                                                | 20 / 20 | 164 / 321         |
| B     | RateLimiter    | ✅ DONE                                                | 21 / 21 | 268 / 441         |
| C     | Schedule       | ✅ DONE                                                | 16 / 16 | 160 / 296         |
| D     | CircuitBreaker | ❌ FAILED (billing/quota error from subagent dispatch) | —       | —                 |

Agent D failed with a Stripe billing error on dispatch — unrelated to the spec or the code. The controller implemented CircuitBreaker directly using the same prompt as the agent's spec; no quality difference.

## Controller-implemented modules

| Module                   | Tests                              | LOC (prod / test) |
| ------------------------ | ---------------------------------- | ----------------- |
| `circuit-breaker.ts`     | 28 / 28                            | ~200 / ~370       |
| `policy.ts`              | 21 / 21                            | ~250 / ~310       |
| Engine integration tests | 4 new (in existing engine.test.ts) | n/a               |

## Quality gates (final state)

```
$ npm run lint
> eslint --cache .
(clean — 0 errors, 0 warnings)

$ npm run typecheck
> tsc --noEmit -p tsconfig.node.json --composite false
> tsc --noEmit -p tsconfig.web.json --composite false
(both pass with no errors)

$ npx vitest run
Test Files  28 passed (28)
     Tests  350 passed (350)
   Duration  ~2.4s

$ npm run build
out/main/index.js                              71.87 kB
out/preload/index.js                            0.81 kB
out/renderer/assets/index-BUorWars.js         588.10 kB
✓ built (no errors)
```

**Test counts:** 240 baseline → 350 after Phase 3 (+110 new tests across 5 new test files + engine.test.ts).

## Notable decisions

1. **zod v3, not v4.** Initial install pulled zod v4, which has stricter typing on `.default({})` for nested object schemas. Downgraded to `^3.23` (the stable line we'd ship anyway).
2. **Separate `electron-store` instance for policy state.** `settings` and `policy-state` are now two distinct stores so a settings reset can't blow away rate-limiter history.
3. **Schedule "disabled" = always awake.** The `reason: 'disabled'` discriminant is reserved in the type but never produced today; schedule-off behavior is identical to pre-Phase-3.
4. **Cross-midnight schedule windows.** Picked the convention "window belongs entirely to one weekday key, even when wrapping past midnight." Documented in `schedule.ts`.
5. **Soft block sleep capped at 5 minutes.** A user configuring 9 AM–6 PM windows would otherwise put the engine into a single multi-hour sleep that ignores stop clicks. Capping forces a re-evaluation tick every 5 min; the engine has a `cancellableSleep` helper for finer-grained interruption.
6. **Engine integration is opt-in.** Engine constructor's `policy` arg is optional; existing callers (tests, Phase-2 paths) work without changes. Only `main/index.ts` wires it in for the production app.
7. **Settings UI deferred.** `policy:get` / `policy:set` / `policy:snapshot` / `policy:resetBreaker` IPC handlers are live, but no renderer page consumes them yet. A future PR will add the "反封号设置" page.

## Files created / modified

```
docs/
  adr/
    0007-anti-detection-policy-architecture.md       (NEW)
  superpowers/
    plans/
      2026-05-05-phase3-anti-detection.md            (NEW)
    decisions/
      2026-05-05-phase-3-execution-log.md            (NEW — this file)

src/core/policy/                                      (NEW directory)
  config.ts
  index.ts
  humanizer.ts          + humanizer.test.ts          (Agent A)
  rate-limiter.ts       + rate-limiter.test.ts       (Agent B)
  schedule.ts           + schedule.test.ts           (Agent C)
  circuit-breaker.ts    + circuit-breaker.test.ts    (controller, after Agent D failed)
  policy.ts             + policy.test.ts             (controller)

src/core/engine.ts          (MODIFIED — +85 LOC for policy hooks + cancellableSleep)
src/core/engine.test.ts     (MODIFIED — +180 LOC for 4 policy integration tests)
src/main/index.ts           (MODIFIED — +90 LOC for KvStorage adapter, policy wiring, 4 IPC handlers)
package.json                (MODIFIED — added zod ^3.23)
```

## What's NOT in this PR (deferred)

- Settings UI page for editing anti-detection config (the IPC is live; the renderer page is a separate PR).
- Per-tick screenshot hashing for freeze detection (`CircuitBreaker.observe({ type: 'screenshotHash' })` works; the engine does not yet feed it).
- OCR pipeline for banned-keyword scanning (`observe({ type: 'screenText' })` works; no engine emitter yet).
- Per-contact rate limiting in the engine (the `RateLimiter.check(contactId)` API supports it; the engine doesn't yet identify contacts).
- Migrating the in-loop polling sleeps in `waitForNextUnread` to Humanizer.

These are tracked in `docs/superpowers/plans/2026-05-05-phase3-anti-detection.md` § "Out of scope".

## Outcome

Phase 3 lands with:

- **5 focused modules**, each with a clean public API and a fake-clock-friendly test surface.
- **All four "kill switches"** the spec asked for: humanizer pacing, rate-limit throttling, schedule windowing, circuit-breaker auto-pause-on-trouble.
- **Production wiring** through `main/index.ts` so the deployed app benefits immediately, even before the settings UI exists.
- **Zero regressions**: all 240 pre-existing tests still pass; 110 new tests added.

The agent now refuses to send messages too fast, paces typing naturally, can be pinned to working hours, and pauses itself (requiring a human resume) on any of five distinct danger signals.
