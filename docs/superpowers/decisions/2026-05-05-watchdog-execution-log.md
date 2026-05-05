# Watchdog — execution log (2026-05-05)

## What landed

The auto-recovery loop sitting on top of the Phase 1 Lifecycle FSM. The
FSM and RestartBudget primitives existed since Phase 1; this PR adds
the actual driver that observes crashes and rebuilds the engine.

```
src/core/runtime/
  watchdog.ts        (NEW — Watchdog class + WatchdogClock injection point)
  watchdog.test.ts   (NEW — 12 tests, FakeClock for deterministic timing)
  index.ts           (re-exports)

src/core/engine.ts
  start() now detects entry from 'recovering' and calls
  lifecycle.recovered() after measureLayout — the handshake that lets
  the Watchdog stay decoupled from engine internals. Crash() in the
  outer catch now also accepts 'recovering' as a legal source.

src/core/engine.test.ts
  +2 recovery-path tests covering the recovering → running and
  recovering → crashed transitions.

src/main/index.ts
  - One Lifecycle per engine:start session, held at module scope so
    Watchdog can rebuild the engine in place.
  - buildEngine() closure used by both initial start and Watchdog
    restart so configuration is captured once.
  - Watchdog wired with default backoff (1s base, 60s cap, ±20% jitter).
  - powerSaveBlocker now released on a definitive 'stopped' OR when the
    Watchdog gives up on 'crashed' — never during transient crashes.

docs/superpowers/plans/2026-05-05-watchdog.md
docs/superpowers/decisions/2026-05-05-watchdog-execution-log.md
```

## Why Engine drives `recovered()` (and not Watchdog)

If Watchdog called `lifecycle.recovered()` the moment `restartFn()`
resolved, the lifecycle would flip to `running` before measureLayout
actually ran. By making Engine call `recovered()` after measureLayout
succeeds, the FSM accurately reflects the moment the agent is back
online. If measureLayout fails on retry, Engine `crash()`-es from
`recovering` and the Watchdog loop kicks in again — no double-counted
attempts.

This handshake is enforced by tests:

- Engine.start() called with lifecycle in `recovering` → no
  `idle->running` transition; emits `recovering->running` on success.
- Engine.start() with measureLayout failure from `recovering` → emits
  exactly `recovering->crashed`.

## FakeClock pattern

`watchdog.test.ts` ships a small `FakeClock` implementing
`WatchdogClock`. Each `tick(ms)` advances a virtual `now` and fires due
timers, then flushes microtasks twice so the test sees the post-await
state without `vi.advanceTimersByTimeAsync` (which doesn't compose
cleanly with our injected clock). Random is fixed at 0.5 by default for
predictable jitter; jitter-bounds tests sweep `[0, 0.25, 0.75, 1]`.

## Liveness probe — designed but not wired

The Watchdog accepts an optional `livenessCheck`. main does NOT pass
one in this PR because the only available signal today is
`engine.isRunning()`, which stays true throughout the loop and
therefore is not a useful probe for "stuck" cases. Phase 4 will add a
per-tick heartbeat counter (`metrics.histogram('engine.tick.duration')`)
and main will wire `livenessCheck` to read its freshness. Tests cover
the API end-to-end so the integration in Phase 4 is a one-liner.

## Notable defensive behaviour

- `attemptRecovery` re-checks `lifecycle.getState()` after the timer
  fires; if the user manually stopped the engine while we were waiting,
  the state moved off `crashed` and we bail without calling `recover()`.
- `restart()` rejection re-pushes the lifecycle to `crashed` so the
  next listener invocation reschedules. Wrapped in a try/catch in case
  the engine has already advanced past `recovering` (rare race) — we
  log and let the next `crashed` event take over.
- `start()` is idempotent. Second call returns immediately.
- `stop()` cancels both the recovery timer and the liveness interval.

## Quality gates

- `npm run lint` clean
- `npm run typecheck` clean
- `npm test` — **240 / 240 passing** (was 226; +12 watchdog + +2 engine
  recovery)
- `npm run build` clean

## Out of scope (deferred)

- Persisting RestartBudget across electron app restarts. Today the
  budget resets when main reloads — fine for crash-loop control, less
  fine for "restart 5 times in 10 minutes" diagnostics across days.
- Per-tick heartbeat instrumentation (Phase 4).
- Pause-on-rate-limit / circuit breaker (Phase 3).
- Process-level recovery (restart electron app itself).
- Renderer-side surfacing of `WatchdogStats`. The Diagnostics UI shows
  the lifecycle state + restart budget already; adding a "next attempt
  in Xs" countdown is straightforward but not in this PR.
