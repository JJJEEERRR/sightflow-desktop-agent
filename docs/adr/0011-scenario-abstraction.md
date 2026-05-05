# ADR-0011: Scenario abstraction for app-specific orchestration

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: architecture, engine, scenarios, refactor

## Context

Spec §6 ("Phase 4 — 多 App 支持") plans growth from WeChat-only to a
multi-app product (飞书 / 钉钉 / Slack). Before this PR the engine was
WeChat-shaped end-to-end:

- The main loop in `Engine.start()` called `device.measureLayout()` and
  drove `device.screenshot()` directly.
- `Engine.executeDecision()` knew that a `reply` decision means
  "send a text via `device.sendMessage()`".
- `Engine.waitForNextUnread()` (~110 LOC) implemented the WeChat
  双通道 detection: chatMainArea-diff + red-dot detection + the
  consecutive-failure → `clearUnreadCache` fallback.

These three responsibilities all assume a WeChat-style UI: a left
contact list with red-dot badges, a single open chat on the right,
double-click activation semantics. Adding a 飞书 implementation under
this shape would mean either:

1. Forking `engine.ts` per app (textbook copy-paste-modify; the loop
   logic, watchdog handshake, OCR sampling, brain wiring would all
   diverge), or
2. Inflating `DesktopDevice` with WeChat-shaped methods like
   `hasUnreadMessage`, `isChatContactUnread`, `clearUnreadCache`,
   `clickUnreadContact` and asking each new app's device to provide
   semantically-equivalent stubs (the interface bloats with every new
   app's UI quirks; its meaning becomes "everything any app might
   ever do" instead of "the device").

Neither is sustainable for a 2-3 app target.

## Decision

Introduce a `Scenario` interface (`src/core/scenarios/types.ts`) — the
swappable per-app orchestration boundary — and split engine
responsibilities along it.

### Scenario surface (locked)

```ts
interface Scenario {
  measureLayout(): Promise<{ success: boolean; error?: string }>
  screenshot(): Promise<string>
  setChatBaseline(): Promise<void>
  clearChatBaseline(): void
  execute(decision: BrainDecision, helpers: ScenarioHelpers): Promise<void>
  waitForNextChat(running: () => boolean, helpers: ScenarioHelpers): Promise<void>
  setAppType?(appType: AppType): void
  dispose?(): Promise<void>
}

interface ScenarioHelpers {
  emitLog: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
  sleep: (ms: number) => Promise<void>
  policy?: AntiDetectionPolicy
  hooks: AgentHooks
}
```

The helpers struct is the only channel through which a scenario
reaches engine-owned plumbing (logging, the policy, the lifecycle
hooks). Scenarios do NOT see the lifecycle FSM, the brain, the
ringbuffer, or the IPC layer.

### What lives where

- **Engine** keeps: lifecycle FSM + Watchdog handshake; `brain.decide`
  loop; `policy.beforeReply` gate at the top of every tick;
  screenshot-hash observation; OCR sampling and `screenText`
  observation; per-tick traceId allocation; `cancellableSleep`;
  emitLog (the structured-log + IPC bridge); error handling and
  crash transitions.
- **Scenario** owns: how to bring the app up (`measureLayout`); how to
  capture a screenshot in _this_ app; how to execute a brain decision
  against _this_ app's UI (today: send a reply); how to wait for the
  next chat to process; how to maintain and tear down the chat-area
  baseline.

### WechatScenario lifts the existing logic verbatim

`WechatScenario` (`src/core/scenarios/wechat/scenario.ts`) takes a
`DesktopDevice` in its constructor and implements the interface by
calling the existing device methods in the same order they were
called from `engine.ts` before this PR. The lifted bookkeeping —
`consecutiveUnreadFailures`, the policy-aware `policyClick` helper —
moves with the code. No behavioural deltas were intended; the 22
existing engine tests continue to pass with mechanical updates only
(wrap each `new Engine(brain, device, ...)` with
`new Engine(brain, new MockScenario(device), ...)`).

### `DesktopDevice` is unchanged in this PR

The interface still exposes WeChat-shaped methods
(`hasUnreadMessage`, `isChatContactUnread`, `activeUnreadByClick`,
`clickUnreadContact`, `clearUnreadCache`, `setChatBaseline`,
`hasChatAreaChanged`, `clearChatBaseline`). Cleaning that up is
deferred — see Open Items. Doing it here would have ballooned the
diff and made bisecting future regressions harder.

### `setAppType` round-trip preserved

The renderer still calls `engine.setAppType(appType)` via the
existing IPC channel. Engine forwards to the scenario's optional
`setAppType` hook; `WechatScenario` delegates to
`device.setAppType`. No renderer changes.

## Consequences

### Positive

- **Engine drops to ~250-300 LOC**, scenario-agnostic. Reading
  `engine.ts` no longer tells you anything about WeChat.
- **Adding 飞书 / 钉钉 / Slack is a new `Scenario` implementation.**
  No engine changes; no risk of regressing the existing app.
- **Scenario surface is small and stable.** Eight methods (two
  optional). Easy to mock, easy to review for new implementers.
- **Cross-cutting concerns stay in one place.** Anti-detection gate
  and OCR sampling live in `processCurrentChat` once, not per
  scenario.
- **Clean test boundary.** WechatScenario has its own focused unit
  tests (~13 tests) covering the WeChat-specific orchestration that
  used to be tangled into engine.test.ts.

### Negative

- **One extra layer in test setup.** Engine tests now construct
  `new MockScenario(device)` instead of passing the device directly.
  Mitigation: `MockScenario extends WechatScenario` so tests
  exercise the same code path as production; no bifurcated coverage.
- **Engine + scenario both hold logic that could be co-located.**
  E.g. `clearChatBaseline` is called both from `Engine.stop()` and
  from inside `waitForNextChat` after switching contacts. The
  duplication is intentional: the engine cleans up at lifecycle
  transitions, the scenario cleans up at scenario-internal
  transitions. Folding them would re-couple the two layers.

### Neutral

- **No IPC contract changes.** Channels and shapes are byte-identical
  to pre-Phase-4. Renderer requires no updates.
- **No new dependencies.**

## Alternatives considered

- **Inline the scenario logic in engine permanently.** Rejected:
  blocks future apps; the file would have to grow either by forking
  per app or by ballooning DesktopDevice with per-app quirks.
- **Polymorphic device.** Rejected: device interface bloats with
  every new app's UI semantics. The device is already a "how do I
  drive _some_ GUI" abstraction; making it also be "how does _this
  particular app_ work" conflates two axes.
- **Plugin architecture with module hot-loading.** Rejected: massive
  overkill for a 2-3 app target. Adds startup-time discovery, version
  matching, signature verification surface for nothing we need today.
- **Make Scenario also own the brain wiring.** Rejected: the brain
  contract is identical across apps (same prompt structure, same
  `BrainDecision` shape today). Pushing it into Scenario would force
  every implementer to repeat the streaming loop, the
  thinking-vs-decision routing, and the aiSuccess/aiFailure
  observations. Engine is the right home.

## Open items

- **Move `src/core/rpa/has-unread.ts`, `window-utils.ts`, and the
  WeChat-specific RPA helpers under `src/core/scenarios/wechat/`.**
  Skipped here to keep the diff focused on the boundary itself; the
  files still live under `src/core/rpa/` and are reachable via the
  same import paths. Pure code movement next-step cleanup.
- **Refactor `DesktopDevice` to drop WeChat-shaped methods**
  (`hasUnreadMessage`, `isChatContactUnread`, `clearUnreadCache`,
  `clickUnreadContact`, `activeUnreadByClick`, `setChatBaseline`,
  `hasChatAreaChanged`, `clearChatBaseline`). They belong on the
  scenario; the device should expose only generic GUI primitives
  (screenshot, click, type, key, measure-layout). Doing this safely
  needs the second scenario to land first so we know what the
  shared device surface actually is.
- **Add a 飞书Scenario.** Out of scope for this PR. Specifying the
  shared device surface (above) is a prerequisite.
- **Per-scenario VLM prompt / language hints.** The brain currently
  takes one global prompt. A future per-`AppType` override is a
  small change inside `BrainContext` once we have the second
  scenario to compare against.
