# Phase 3 — Anti-Detection Implementation Plan

> **For agentic workers:** Subagents implement individual modules in isolation per the contracts below. Controller integrates Policy + Engine + main wiring sequentially after subagents return.

**Goal:** Build the anti-detection middleware (Humanizer + RateLimiter + Schedule + CircuitBreaker → Policy) and wire it into the engine loop so the agent throttles, paces, and self-pauses based on configured policy.

**Architecture:** Five independent modules + a thin Policy combinator. Engine consumes Policy at three hooks (`beforeReply` / `beforeAction` / `afterAction`) and forwards observed signals (`aiSuccess`/`aiFailure`/`rpaSuccess`/`rpaFailure`/`screenText`). Config is zod-validated end-to-end and persisted via electron-store. Each module is built behind a clock/storage injection point so unit tests are deterministic.

**Tech Stack:** TypeScript, zod (NEW dep, just added), electron-store (existing), vitest, existing observability (`getLogger`).

---

## File map

```
src/core/policy/                   (NEW directory)
  config.ts                        — zod schemas + types (controller writes first)
  humanizer.ts                     — Agent A
  humanizer.test.ts                — Agent A
  rate-limiter.ts                  — Agent B
  rate-limiter.test.ts             — Agent B
  schedule.ts                      — Agent C
  schedule.test.ts                 — Agent C
  circuit-breaker.ts               — Agent D
  circuit-breaker.test.ts          — Agent D
  policy.ts                        — controller (combinator)
  policy.test.ts                   — controller
  index.ts                         — controller (public re-exports)

src/core/engine.ts                 — controller (consumes Policy)
src/main/index.ts                  — controller (config persistence + wiring)
src/core/engine.test.ts            — controller (+ policy integration tests)
```

## Default config values (zod schema)

Drop-in defaults baked into the zod schemas. Treat these as **the contract** — agents must match field names exactly.

```ts
// HumanizerConfig
preActionDelayMs: [80, 220] // ms range, uniform random
postActionDelayMs: [200, 500]
clickJitterPx: 2 // ± px on each axis
charsPerSecond: [4, 8]
punctuationPauseMs: [100, 300]
typoProbability: 0.02
longPauseProbability: 0.05
longPauseMs: [1500, 4000]
readDelayMs: [400, 1500] // applied before screenshot

// RateLimiterConfig
globalPerHour: 30
perContactPerDay: 20
minIntervalMs: 8000
newContactCooldownMs: 60000

// ScheduleConfig
enabled: false // off by default; UI lands later
windows: {
} // weekday → array of [HH:MM, HH:MM]
afkProbability: 0.05
afkDurationMs: [30000, 180000]

// CircuitBreakerConfig
consecutiveAiFailures: 5
consecutiveRpaFailures: 3
duplicateReplyCount: 3
screenshotFreezeMs: 300000
bannedKeywords: ['账号异常', '冻结', '违规']
```

## Public APIs (locked — agents must match)

### Humanizer

```ts
export interface HumanizerClock {
  sleep(ms: number): Promise<void>
  random(): number
}

export class Humanizer {
  constructor(opts: { config: HumanizerConfig; clock?: HumanizerClock })
  updateConfig(patch: Partial<HumanizerConfig>): void

  preActionDelay(): Promise<void>
  postActionDelay(): Promise<void>
  readDelay(): Promise<void>
  maybeLongPause(): Promise<void> // returns immediately ~95% of the time

  jitterCoords(x: number, y: number): [number, number]

  // Streams pacing events for sending text. Engine/device interpret each:
  //  - { type: 'type', ms }     — sleep ms then type next char
  //  - { type: 'pause', ms }    — long pause / punctuation pause / read delay
  //  - { type: 'typo', ms, char } — type wrong char + backspace + correct char
  typingPlan(text: string): AsyncIterable<TypingStep>
}

export type TypingStep =
  | { type: 'type'; ms: number; charIndex: number }
  | { type: 'pause'; ms: number; reason: 'punctuation' | 'long' }
  | { type: 'typo'; ms: number; charIndex: number; wrongChar: string }
```

### RateLimiter

```ts
export interface KvStorage {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
}

export class RateLimiter {
  constructor(opts: { config: RateLimiterConfig; storage: KvStorage; now?: () => number })
  updateConfig(patch: Partial<RateLimiterConfig>): void

  // contactId omitted = global-only check
  check(
    contactId?: string
  ):
    | { allowed: true }
    | {
        allowed: false
        retryAfterMs: number
        reason: 'globalPerHour' | 'perContactPerDay' | 'minInterval' | 'newContactCooldown'
      }

  // Records a successful send (called by Policy.afterAction on type='reply')
  recordSend(contactId?: string): void

  // For diagnostics IPC and tests
  snapshot(): {
    hourly: { used: number; max: number; resetAt: number }
    perContact: Record<string, { used: number; max: number; resetAt: number }>
    lastSendAt: number
  }
}
```

Persistence keys (in `KvStorage`): `policy.rateLimiter.hourly`, `policy.rateLimiter.perContact`, `policy.rateLimiter.lastSendAt`.

### Schedule

```ts
export class Schedule {
  constructor(opts: { config: ScheduleConfig; now?: () => Date; random?: () => number })
  updateConfig(patch: Partial<ScheduleConfig>): void

  // Inside an allowed weekday window? When disabled, always awake.
  isAwake():
    | { awake: true }
    | { awake: false; nextAwakeAt: Date | null; reason: 'outOfWindow' | 'disabled' }

  // Roll for random AFK pause (used per-tick by Policy)
  maybeAfk(): { afk: false } | { afk: true; durationMs: number }
}
```

Window format: `windows[weekdayString]: Array<[startHHMM, endHHMM]>` where weekdayString ∈ `'0'..'6'` (0=Sunday). HH:MM strings are local time, e.g. `"09:00"`. Empty/missing weekday → no windows that day.

### CircuitBreaker

```ts
export type BreakerSignal =
  | { type: 'aiFailure'; err?: Error }
  | { type: 'aiSuccess' }
  | { type: 'rpaFailure'; err?: Error }
  | { type: 'rpaSuccess' }
  | { type: 'replyText'; text: string }
  | { type: 'screenshotHash'; hash: string }
  | { type: 'screenText'; text: string }

export type BreakerReason =
  | 'consecutiveAiFailures'
  | 'consecutiveRpaFailures'
  | 'duplicateReply'
  | 'screenshotFreeze'
  | 'bannedKeyword'

export class CircuitBreaker {
  constructor(opts: { config: CircuitBreakerConfig; now?: () => number })
  updateConfig(patch: Partial<CircuitBreakerConfig>): void

  observe(signal: BreakerSignal): void

  // After observe(), the breaker may have tripped. Engine (via Policy) checks
  // before each tick.
  state(): { tripped: false } | { tripped: true; reason: BreakerReason; detail: string }

  // Manually reset (called when user resumes from a pause)
  reset(): void

  snapshot(): {
    /* counters, last hash time, last seen text */
  }
}
```

## Wave 1 — parallel agents (4 modules)

Each agent gets its full task description below. They share these baseline rules:

- **Use TDD.** Write the failing test first.
- **Existing files**: do not modify any file outside your own directory. The schemas in `src/core/policy/config.ts` already exist by the time you run; import from there.
- **No new deps.** zod is already added.
- **Logging**: use `getLogger('policy.<modulename>')` from `../observability`.
- **Clocks**: every random/time source must be injectable via the constructor `clock?` / `now?` option for testability.
- **Quality gates** (your responsibility before reporting DONE):
  - `npm run lint` clean
  - `npm run typecheck` clean
  - `npx vitest run src/core/policy/<your-file>.test.ts` green
- **Do not edit** `engine.ts`, `main/index.ts`, `policy.ts`, `index.ts`. Those are the controller's job.

## Wave 2 — controller integration (sequential)

After agents return:

1. Write `policy.ts` — combinator + `policy.test.ts`.
2. Update `engine.ts` to call `policy.beforeReply` at top of loop, `policy.beforeAction`/`afterAction` around `device.sendMessage`, and `policy.observe` for AI/RPA outcomes.
3. Update `main/index.ts` to load `antiDetection` config from electron-store with zod parse, build a Policy instance, pass it to Engine.
4. Add IPC handlers: `policy:get`, `policy:set` (zod-parsed), `policy:snapshot`. UI is deferred to a separate PR (the spec's "反封号设置页" — explicit out-of-scope here).
5. Add 3-4 engine integration tests covering the new policy hooks.

## Out of scope (deferred)

- Settings UI for anti-detection config — separate PR.
- Per-tick screenshot hashing for freeze detection (CircuitBreaker accepts the signal but Engine doesn't compute hashes yet — that's a one-line Engine addition once the agent is more mature).
- Banned-keyword OCR scan (CircuitBreaker accepts `screenText` signal; OCR pipeline is a future tick).
- Migrating the legacy `engine.ts` `sleep(150 + Math.random()*100)` calls is partially in scope (only the ones around `sendMessage`); the in-loop polling sleeps stay as-is for now to keep this PR reviewable.
