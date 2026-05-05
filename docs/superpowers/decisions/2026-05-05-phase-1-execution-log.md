# Phase 1 — Observability & Lifecycle: Execution Log

> Companion to `docs/superpowers/plans/2026-05-05-phase1-observability-lifecycle.md`
> and `docs/adr/0005-observability-and-lifecycle-architecture.md`. Records every
> decision and pivot taken during autonomous execution so future agents can
> rebuild context without replaying the chat.

---

## 2026-05-05 11:00 — Multi-agent fan-out

Per the user's request to use multi-agent for speed, dispatched two subagents
on independent workstreams:

- **Subagent A** — built `src/core/observability/` (logger, metrics, trace,
  redact, three sinks, types, index) + tests. 9 source files, 5 test files,
  72 new tests.
- **Subagent B** — built `src/core/runtime/` (Lifecycle FSM, RestartBudget,
  types, index) + tests. 4 source files, 2 test files, 46 new tests.

Both finished green: 0 lint, clean typecheck, 100% module coverage. Subagent A
also normalised prettier in Subagent B's files via `--fix` (no logic change)
so the global lint gate stayed green for the merged tree.

---

## 2026-05-05 11:05 — Integration design choices

When wiring the new modules into the existing Engine, two questions had to be
resolved before any edits:

1. **Should `Engine.isRunning()` derive from Lifecycle state?**

   Decision: **No, keep `this.running` as the loop guard**. Lifecycle is the
   _outward_ surface for observers (main process, IPC); `this.running` is the
   _inward_ loop control. Mixing the two creates dual sources of truth and
   risks the `while (this.running)` loop reading a transitioning value mid-tick.
   Lifecycle subscribers re-derive whatever they need from the snapshot.

2. **Should the legacy `engine:log` IPC payload survive?**

   Decision: **Yes, run both channels in parallel for one cycle**. The
   renderer currently consumes `engine:log` (`{type, content}` semantic
   payload). Phase 5 will replace it. For now, `Engine.emitLog()` calls _both_
   the legacy callback _and_ `this.log.child(`engine.${type}`)`, so structured
   sinks (file, ring buffer) get the same record without breaking the UI.

---

## 2026-05-05 11:10 — Engine integration

`src/core/engine.ts`:

- Added `lifecycle?: Lifecycle` as a 4th optional ctor arg (defaults to
  `new Lifecycle()`). Ergonomic for tests, transparent in production.
- Added `getLifecycle()` and `setAppType()` (the latter was already public)
  to the Engine API surface.
- Each tick now allocates a fresh `traceId` via `newTraceId()` and stores it
  on `this.currentTraceId`; the bound child logger inside `emitLog()` picks
  it up automatically.
- Lifecycle transitions:
  - `start()` → `idle → running` (guarded if already running).
  - `measureLayout` failure → `running → crashed` with `new Error(reason)`
    so the snapshot captures `lastError`.
  - `stop()` → safe transition to `stopped` from any of `running | paused |
crashed` (idle and recovering reject `stop()` per FSM spec).
  - Catastrophic uncaught error in `start()` → `crash()` if still running.
- Replaced 3 `console.*` calls with structured logger writes.

Test impact: the existing 8 engine tests pass unchanged; added **3 new
integration tests** (clean run, measureLayout-fail crash, double-start no-op)
covering the lifecycle wiring end-to-end.

---

## 2026-05-05 11:15 — AI client / LocalHooks / RPADevice integration

Replaced every `console.*` call in:

- `ai-client.ts` (10 calls): `[AIClient] callAPI` debug, `getReply` start/done,
  401/timeout/exception errors all flow through `getLogger('ai-client')` with
  structured fields (`elapsedMs`, `status`, `model`, `payloadKB`).
- `local-hooks.ts` (5 calls): `[LocalHooks] Engine started`, connection check,
  `onActionComplete`, `onError` now emit structured records under the
  `hooks.local` phase. The `err` field is automatically split off by the
  logger so stack traces survive intact.
- `rpa-device.ts` (17 calls): `measureLayout` happy + sad paths,
  `hasUnreadMessage` and `isChatContactUnread` failures, `clearUnreadCache`
  audit log all go through `getLogger('rpa-device')`.

Two test files needed adapting because they used `vi.spyOn(console, 'error')`
to assert on log output:

- `ai-client.test.ts`: 1 test was rewritten to install a `RingBufferSink`
  in `beforeEach`, then assert on `logBuffer.getAll().filter(r => r.level
=== 'error')` for the 401 path. The remaining 11 tests still pass (the
  no-op console spies they kept don't fail when uncalled).
- `local-hooks.test.ts`: 3 console-based assertions migrated to the same
  `RingBufferSink` pattern. The `ConsoleSpy` type alias was deleted.

The RPA _leaf_ modules (`src/core/rpa/*.ts`, `mock-device.ts`,
`rpa/tests/*.ts`) were **deliberately left untouched** in this PR — the
plan's section 4 only lists the four files migrated above. Migrating leaves
will be Phase 2 (it can land alongside the watchdog work without conflict).

---

## 2026-05-05 11:25 — Main process integration

`src/main/index.ts` is now the observability boot site:

```text
RingBufferSink (2k) ─┐
                     │
ConsoleSink (dev)  ──┤
                     ├──▶ configureLogger({ env, sinks, minLevel })
JsonFileSink        ─┤    │
  (userData/logs/    │    │
   YYYY-MM-DD.jsonl, │    │
   maxDays=14)       │    │
                     │    │
RendererSink ────────┘    │
  (forwards every record       ▼
   to webContents on the    every getLogger(phase) call
   `engine:log-record`      after this point fans out
   channel)                 to all four sinks
```

New IPC channels (additive — legacy `engine:log` still fires):

- `engine:log-record` (push) — full `LogRecord` per write.
- `engine:state` (push) — `{event, snapshot}` on every Lifecycle transition.
- `engine:lifecycle` (invoke) — returns the current `LifecycleSnapshot`.
- `logs:recent` (invoke, limit:number=200) — last N records from the ring
  buffer, useful for a future Diagnostics tab and ad-hoc DevTools work.

`powerSaveBlocker` is now gated on the lifecycle: it starts on the very
first transition to `running`, stops on either `stopped` or `crashed`.
Restart attempts (Phase 2) will reuse the same handle.

Process safety nets installed at module load:

- `process.on('unhandledRejection', …)` — logs `err` field, does not exit.
- `process.on('uncaughtException', …)` — same; Phase 2 watchdog will decide
  whether to escalate.

`permission.ts` was migrated as a bonus since it sits in the main bundle and
its 7 console calls were the only remaining `console.*` calls in the
production main path.

---

## 2026-05-05 11:35 — Quality gates

| Gate                             | Result                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run lint`                   | 0 errors, 0 warnings                                                                    |
| `npm run typecheck` (node + web) | clean                                                                                   |
| `npm test`                       | **199/199** pass (was 196 before integration; +3 lifecycle integration tests on Engine) |
| `npm run test:coverage`          | **53.55%** lines / 88.37% branches / 73.09% functions (above the 50% global floor)      |
| `npm run build`                  | preload + renderer chunks emit without errors                                           |

One small papercut surfaced and was fixed during integration: the JsonFileSink
constructor takes `dailyRotation: boolean` + `maxDays?: number`, not
`retentionDays` (my plan doc was sloppy). The boot site now matches the actual
API. No code in the sink had to change.

---

## What is intentionally _not_ in this PR

- **Watchdog & auto-restart loop** — deferred to Phase 2. The Lifecycle's
  `crash → recover → recovered` path is fully implemented and unit-tested,
  but no caller invokes `recover()` yet. This is a deliberate scope cut so
  the integration PR stays reviewable.
- **RPA leaf migration** — see "AI client / LocalHooks / RPADevice"
  section. ~70 console calls remain in `rpa/*.ts`; they will move in
  Phase 2 alongside the watchdog.
- **Diagnostics UI** — the `logs:recent` IPC handler is live but no renderer
  consumes it. Phase 5 (UX overhaul) will add the panel.
- **Full secret-redaction sweep** — `redact.ts` already covers the obvious
  keys (`apiKey`, `token`, `password`, …) and email-like values. A
  comprehensive audit (e.g. body-payload preview redaction in `ai-client.ts`)
  will follow once the surface stabilises.
