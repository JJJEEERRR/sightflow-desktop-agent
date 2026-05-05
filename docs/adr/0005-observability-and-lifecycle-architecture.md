# 0005 — Observability + Lifecycle architecture (Phase 1)

- **Status:** Accepted
- **Date:** 2026-05-05
- **Deciders:** Phase 1 implementation (`feat/phase-1-observability-lifecycle`)
- **References:** `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md` § 3.3, § 3.5, § 6 / `docs/superpowers/plans/2026-05-05-phase1-observability-lifecycle.md`

## Context

Before Phase 1, the engine logged via raw `console.log/warn/error`, had no
metrics surface, and tracked its running state with a single boolean
(`Engine.running`). This made:

- Long-run debugging painful (no structured logs, no per-trace correlation).
- Recovery semantics implicit (no place for "paused by user" vs "paused by
  circuit breaker" — Phase 3 needs that distinction).
- The future Diagnostics panel (Phase 5) impossible to build without first
  having a log buffer, metrics snapshot, and observable state transitions.

Spec § 3.5 calls for a structured logger with three sinks (console + JSON
file + ring buffer), a tiny in-memory metrics module, and a trace-context
abstraction. Spec § 3.3 calls for a 6-state lifecycle FSM
(`idle | running | paused | crashed | recovering | stopped`).

## Decision

We split Phase 1 into two completely orthogonal modules so they can be built
in parallel and consumed independently by later phases:

### 1. `core/observability/` — logger / metrics / trace

```
src/core/observability/
├── types.ts              LogRecord, Logger, MetricsSnapshot, TraceContext
├── logger.ts             configureLogger / getLogger / phase-scoped child loggers
├── metrics.ts            Metrics class (counter, histogram, snapshot)
├── trace.ts              newTraceId / newSpanId / withSpan
├── redact.ts             deep-clone with sensitive-key + email masking
├── sinks/
│   ├── console-sink.ts   colorised dev console
│   ├── ring-buffer-sink.ts  last N records in memory (UI streaming)
│   └── json-file-sink.ts daily-rotating .jsonl in <userData>/logs
└── index.ts
```

- Sinks are decoupled from the Logger — multiple sinks fan out per record.
- Console sink is dev-only (colorised). JSON file sink runs only in main
  process (needs `fs` + Electron's `userData`). Ring buffer is universal.
- Logger is pure; the whole module has zero hard dependency on Electron.
  Electron-aware wiring lives in `main/index.ts` (calls `configureLogger`
  with the `JsonFileSink` constructed from `app.getPath('userData')`).
- Metrics is in-memory only. Snapshot is the surface the future Diagnostics
  IPC handler returns.
- Trace exports `withSpan(parent, name, fn)` — Phase 1 only uses single-level
  `traceId`, but the API is shaped for nested spans (Phase 2's ReAct will need
  multi-step trace).

### 2. `core/runtime/` — lifecycle state machine + restart budget

```
src/core/runtime/
├── types.ts              LifecycleState, PauseReason, LifecycleSnapshot, IllegalTransitionError
├── lifecycle.ts          FSM with 10 legal transitions; subscribe()/snapshot()
├── restart-budget.ts     Sliding-window restart counter (5 within 1h default)
└── index.ts
```

- Pure logic — runs in Node and the browser, no Electron import.
- `Lifecycle` is the **single source of truth** for engine state. The Engine
  surfaces a thin proxy (`engine.getLifecycle()`) so callers don't have to
  know about both. The legacy `engine.isRunning()` is kept for backwards
  compat (returns `state === 'running'`).
- Illegal transitions throw `IllegalTransitionError` — this is a programmer
  bug, not a user error. Loud failure surfaces wiring mistakes early.
- `restart-budget` is split into its own file because Phase 3's watchdog will
  also consume it.

### Integration touch list

| File                      | Change                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/engine.ts`      | Replace `console.log/error` with `getLogger('engine')`. Inject `Lifecycle`. Drive `start/stop/crash/pause/recover` calls. Keep legacy `LogEmitter` callback.                                                                               |
| `src/core/ai-client.ts`   | Replace `console.error` with `getLogger('ai-client')`.                                                                                                                                                                                     |
| `src/core/local-hooks.ts` | Replace `console.*` with `getLogger('hooks.local')`.                                                                                                                                                                                       |
| `src/core/rpa-device.ts`  | Replace `console.*` with `getLogger('device.rpa')`.                                                                                                                                                                                        |
| `src/core/rpa/*.ts`       | Replace `console.*` with `getLogger('rpa.<file>')` (mechanical).                                                                                                                                                                           |
| `src/main/index.ts`       | Boot order: `configureLogger` → process hooks → lifecycle wiring → `powerSaveBlocker` subscription → IPC handlers (`diagnostics:getLogBuffer`, `diagnostics:getMetricsSnapshot`, broadcast `engine:state`, broadcast `engine:log-record`). |
| `src/main/permission.ts`  | Replace `console.*` with `getLogger('main.permission')`.                                                                                                                                                                                   |

`src/preload/index.ts` requires no changes — it's a generic invoke/on/send
bridge that already accepts arbitrary channel names.

## Consequences

### Positive

- **All `console.*` calls disappear from `core/` and `main/`.** Future
  diagnostic work has a single, structured place to look.
- **Phase 5 Diagnostics panel becomes trivial** — just consume the ring
  buffer + metrics snapshot via the new IPC channels.
- **Phase 3 Anti-Detection's circuit breaker** has a clean integration
  point: `breaker.trip(reason)` → `lifecycle.pause('breaker')`. The existing
  user-pause path is unaffected because `PauseReason` distinguishes them.
- **Phase 2 Brain's ReAct multi-step reasoning** can use `withSpan` to draw
  nested traces without re-architecting trace propagation.
- **Lifecycle transitions are now a typed contract.** The `IllegalTransitionError`
  class catches "engine.stop() called from idle" type bugs at the call site
  rather than producing silent UB.
- **Restart budget is reusable.** Phase 3's watchdog and any future supervisor
  can reuse `RestartBudget` instead of re-implementing sliding windows.

### Negative

- **Logger requires explicit `configureLogger` at boot.** Forgetting to call
  it means logs go to a no-op sink. Mitigation: in dev, log loudly to
  `console.error` if `getLogger` is called before configure.
- **`engine:log-record` is in addition to the legacy `engine:log` channel.**
  Renderer keeps consuming the legacy one until Phase 5; until then, two
  channels carry partially-overlapping data. Acceptable short-term cost.
- **`powerSaveBlocker` subscribes to lifecycle events**, so a forgotten
  `lifecycle.subscribe` call would leak the wake lock. Mitigation: the wiring
  is centralised in `main/index.ts`; covered by an integration smoke test.

### Neutral

- **No new npm dependencies.** `electron-log` was already present but we
  ended up not using it directly — its API is OK but its sink model isn't
  flexible enough for our 3-sink fan-out + redact pipeline. Our logger uses
  Node built-ins only (`fs`, `path`, `crypto`).

## Alternatives considered

### A. Use `pino` for logging

- **Pro:** Battle-tested, fast, ecosystem.
- **Con:** Heavyweight in renderer (we don't log there yet, but the option
  closes if pino is in our import graph). Requires transports for our 3-sink
  fan-out. We need synchronous behavior for deterministic test ordering;
  pino is async-by-design.
- **Verdict:** Re-evaluate at Phase 5 when the renderer also starts logging.

### B. Use `electron-log` directly

- **Pro:** Already in `package.json`. First-class Electron support.
- **Con:** Single-stream model; redact + ring buffer require monkey-patching.
  No structured-record-first API.
- **Verdict:** Adopt only as the JSON file sink's underlying writer if we
  want log rotation for free — currently we hand-roll it (~80 lines) to
  avoid adding an indirection.

### C. Keep the boolean `Engine.running` and bolt pause/error states on as flags

- **Pro:** Minimal diff.
- **Con:** Every consumer (UI, IPC, Phase 3 breaker) would have to read
  multiple flags and reason about ordering. An FSM enforces "paused while
  recovering is impossible" at compile time.
- **Verdict:** Reject. The FSM cost (~250 lines + tests) is paid down twice
  by Phase 3 and Phase 5.

### D. Implement watchdog now (per spec § 3.4)

- **Pro:** Spec lists watchdog under Phase 1.
- **Con:** Watchdog is meaningful only when paired with the circuit breaker
  signals (Phase 3); without those signals it can only restart on heartbeat
  timeout, which adds complexity for marginal value.
- **Verdict:** Defer to Phase 3. Phase 1 ships `lifecycle.recover()` +
  `RestartBudget` so Phase 3's watchdog has clean injection points.

## References

- Spec: `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md`
- Plan: `docs/superpowers/plans/2026-05-05-phase1-observability-lifecycle.md`
- ADR 0004: TypeScript strictness (the `no-any` rule that this code obeys)
- pino: https://github.com/pinojs/pino (alternative considered)
- electron-log: https://github.com/megahertz/electron-log (alternative considered)
