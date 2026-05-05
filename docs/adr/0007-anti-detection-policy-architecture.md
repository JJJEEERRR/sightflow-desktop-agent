# ADR 0007 — Anti-Detection Policy as Five-Module Combinator

**Status:** Accepted
**Date:** 2026-05-05
**Phase:** 3

## Context

Phase 3 calls for an "anti-detection" middleware that throttles, paces, and self-pauses the WeChat agent so an account is less likely to be flagged. The spec (§3.2) breaks the surface area into five concerns: humanization (Humanizer), rate limiting (RateLimiter), schedule windows (Schedule), circuit breaking (CircuitBreaker), and a thin combinator (Policy).

We had to decide:

1. **One mega-class vs. five focused modules.** Either pattern can satisfy the spec.
2. **Where the "should I send right now?" decision lives.** Inline in the engine, or behind a single `policy.beforeReply()`.
3. **How config is parsed and persisted.** Free-form JSON, hand-written validators, or a schema library.
4. **Whether the breaker can auto-resume.**
5. **How aggressively to migrate existing `engine.ts` sleep calls into the Humanizer.**

## Decision

### 1. Five focused modules + a thin combinator

Each module owns exactly one concern, has a tiny public API (one or two methods plus `updateConfig` + `snapshot`), and is testable in isolation with a fake clock / fake KvStorage. The Policy class is a < 250 LOC combinator: it sequences gates, awaits humanizer delays, and forwards observed signals to the breaker. It owns no state itself — every counter lives in the underlying module.

Rationale: each of the five concerns evolves independently (rate-limit math is unrelated to typing cadence which is unrelated to weekday windows). Keeping them as separate files lets us iterate one without touching the others, and makes it easy for parallel agents to implement them concurrently.

### 2. Single integration point in the engine

The engine consumes Policy at exactly four points:

| Hook                                  | When                                                       | Purpose                                                                            |
| ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `policy.beforeReply(ctx)`             | Top of `processCurrentChat`                                | Gate (breaker / schedule / rate-limit) + apply read/AFK/long-pause                 |
| `policy.beforeAction(action)`         | Before each `device.sendMessage`                           | Pre-action humanizer delay; coord jitter for clicks                                |
| `policy.afterAction(action, outcome)` | After each `device.sendMessage`                            | Post-action delay; record send into rate-limiter; observe RPA outcome into breaker |
| `policy.observe(signal)`              | Around `brain.decide` and on banned-keyword scans (future) | Feed AI / screen signals into the breaker                                          |

Why a single `beforeReply` rather than four engine-side checks: the engine doesn't need to know the difference between a rate-limit miss, an out-of-window block, and a tripped breaker. It only needs to know _should I proceed, and if not, do I sleep or pause?_ The discriminator is the `pause?` field on `BeforeReplyResult` — only the breaker sets it; everything else is a "soft" wait.

### 3. zod for config validation, separate `policy-state` electron-store

Both decisions are about preventing bad state from corrupting the runtime:

- **zod**: hand-written validators are how config drift bugs ship. The schema lives in `src/core/policy/config.ts` and is the single source of truth for both default values and field types. The renderer can call `policy:get`, edit, and `policy:set`, with main rejecting invalid patches before they hit disk.
- **Separate `policy-state` store**: rate-limiter counters and breaker state are _engine-managed_ runtime data, not user preferences. Co-locating them with `settings` means a settings reset would silently nuke an entire week of rate-limiter history. We keep them in their own `electron-store` instance keyed by `policy.rateLimiter.*`.

### 4. The breaker NEVER auto-resumes

§3.2.4 of the spec is explicit ("绝不自动重启"). The breaker is sticky once tripped; reset is a deliberate user action exposed via `policy:resetBreaker`. The Watchdog only acts on `crashed` lifecycle states, never on `paused`, so a breaker-trip cannot trigger a recovery loop. This is the most important safety property of the whole feature.

### 5. Migrate only the high-risk sleeps

We migrate `device.sendMessage` (the action that risks an account suspension) under `beforeAction`/`afterAction`. The polling sleeps inside `waitForNextUnread` stay as the existing inline `sleep(150 + Math.random() * 100)` calls — they don't move data outbound and migrating them would balloon this PR for no anti-detection benefit. Future PRs can move them under Humanizer if we ever want unified pacing observability.

## Alternatives considered

**Mega-class `AntiDetectionMiddleware`.** Rejected: bundles four orthogonal concerns into one file, makes parallel implementation impossible, and forces the Humanizer's clock injection to leak into the rate-limiter's storage injection.

**Lifecycle `pause('silentWindow')` for schedule out-of-window.** Rejected: schedule out-of-window is a transient soft block that should resume automatically when the window opens. Coupling it to lifecycle pause would require a separate "auto-resume timer" service, doubling the moving parts. Today the engine just sleeps `min(msUntilNextWindow, 5min)` and re-evaluates.

**Inline schema + plain TS interfaces.** Rejected: persisted config from `electron-store` is `unknown`, and a zod parse + default cascade is the cheapest way to ensure every consumer sees a fully-formed config blob.

**Migrate every `engine.ts` sleep.** Rejected for this PR (see §5 above). Documented as deferred.

## Consequences

**Wins:**

- Each module is < 270 LOC and tests in isolation (humanizer 164, rate-limiter 268, schedule 160, circuit-breaker ~200).
- Subagent-friendly: parallelizable to four implementer agents.
- One integration point in `engine.ts` (~30 LOC of changes) — easy to read and revert.
- No new long-running deps: zod is the only addition (small, well-typed, zero-runtime overhead post-parse).

**Costs:**

- Five files where two might do (the cost of separation of concerns).
- Settings UI for anti-detection config is deferred to a separate PR (the IPC handlers `policy:get/set/snapshot/resetBreaker` are wired, but no renderer UI exists yet — users edit via JSON in `electron-store`).

**Risks:**

- Field-name drift between schema and consumers. Mitigated by `z.infer` types — every consumer imports the type derived from the schema, so a schema rename surfaces as a TS error in every consumer.
- The "soft block waitMs" sleep inside the engine is currently capped at 5 min so a stop click is observable; if a user configures a 6 AM–10 PM window, the agent will tick once a minute during off-hours just to log "still asleep." Acceptable for v1; revisit if it becomes noisy.

## Migration

No migration needed for existing users. `parseAntiDetectionConfig({})` produces a fully-defaulted config, so users who never open a settings page (which doesn't exist yet) get safe defaults: humanizer enabled, rate-limit at 30/h, schedule disabled, circuit breaker enabled.
