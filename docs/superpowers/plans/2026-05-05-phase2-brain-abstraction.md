# Phase 2 — Brain Abstraction (Implementation Plan)

> Companion to `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md`
> §3.3 Brain and §6 Phase 2.

---

## 1. Why

Today the Engine is hard-wired to the VLM-style "screenshot → reply text"
pipeline through `LocalHooks.getReply` → `AIClient`. To get to a stronger
agent (memory + tools + multi-step reasoning) without ripping the engine
apart, we need a **stable abstraction** for the decision-making component.

Phase 2 introduces that abstraction (`AgentBrain`), retains today's behaviour
behind a `VlmBrain` implementation, and re-points the Engine at it. Hooks
shrink to lifecycle/error/external-trigger callbacks only.

---

## 2. Module layout

```
src/core/
├── ai-client.ts                   (unchanged in shape; adds public callVision)
├── brain/
│   ├── index.ts                   public re-exports
│   ├── types.ts                   AgentBrain, BrainContext, BrainDecision, BrainStream, BrainConfig
│   ├── vlm-brain.ts               VlmBrain implements AgentBrain
│   ├── vlm-brain.test.ts
│   └── providers/
│       ├── types.ts               ChatProvider, ChatProviderConfig
│       ├── openai-compat.ts       OpenAICompatProvider implements ChatProvider
│       └── openai-compat.test.ts
├── hooks.ts                       (slim: drop getReply; lifecycle/exec/error stay)
├── local-hooks.ts                 (slim: drop getReply, drop aiClient)
└── engine.ts                      (consumes AgentBrain instead of hooks.getReply)
```

---

## 3. Public API

### 3.1 `brain/types.ts`

```ts
export interface BrainContext {
  /** WeChat / WeWork / WhatsApp — future brains pick prompt variants from this. */
  appType: AppType
  /** Base64 PNG, may include or omit the `data:image/png;base64,` prefix. */
  screenshot: string
  /** Optional trace ID propagated from the engine's per-tick traceId. */
  traceId?: string
  /** Reserved for memory/tools (Phase X). VlmBrain ignores it today. */
  history?: unknown[]
}

export type BrainDecision = { type: 'reply'; text: string } | { type: 'skip'; reason?: string }

export interface BrainStream {
  /** Optional progress message; engine routes it to `emitLog('thinking', …)`. */
  thinking?: string
  /** Final decision; engine executes via `device.sendMessage` etc. */
  decision?: BrainDecision
}

export interface BrainConfig {
  apiKey: string
  model?: string
  baseURL?: string
  systemPrompt?: string
}

export interface AgentBrain {
  decide(ctx: BrainContext): AsyncIterable<BrainStream>
  testConnection(): Promise<{ success: boolean; error?: string }>
  updateConfig(config: Partial<BrainConfig>): void
}
```

### 3.2 `brain/providers/types.ts`

```ts
export interface ChatProviderConfig {
  apiKey: string
  model: string
  baseURL: string
}

export interface ChatProvider {
  callVision(systemPrompt: string, userText: string, imageBase64: string): Promise<string>
  callText(message: string): Promise<string>
  testConnection(): Promise<{ success: boolean; error?: string }>
  updateConfig(config: Partial<ChatProviderConfig>): void
}
```

### 3.3 `brain/providers/openai-compat.ts`

Thin wrapper around the existing `AIClient` (which already implements
OpenAI-compatible `/chat/completions`). The wrapper exists to stabilise the
interface that `VlmBrain` consumes — when we add Anthropic / Ollama / local
mock providers, only this layer changes.

> **Decision** — we do _not_ introduce `ai-sdk` (Vercel) in this PR even
> though the spec mentions it. Justification:
>
> 1. `AIClient` already does what we need with structured logging and
>    proper timeout/abort handling, all unit-tested.
> 2. `ai-sdk` is ESM-only and adds nontrivial bundler/CJS friction we'd
>    rather not absorb in a Brain-abstraction PR.
> 3. The `ChatProvider` interface is intentionally `ai-sdk`-shaped, so we
>    can swap the implementation later without touching VlmBrain.
>    Recorded in ADR `0006-defer-ai-sdk-keep-fetch-based-provider.md`.

### 3.4 `brain/vlm-brain.ts`

```ts
export interface VlmBrainOptions {
  provider: ChatProvider
  systemPrompt?: string
}

export class VlmBrain implements AgentBrain {
  // …
  async *decide(ctx: BrainContext): AsyncIterable<BrainStream> {
    if (!ctx.screenshot) {
      yield { decision: { type: 'skip', reason: 'empty screenshot' } }
      return
    }
    yield { thinking: '正在分析聊天内容...' }
    try {
      const text = await this.provider.callVision(
        this.systemPrompt,
        '请根据截图中微信聊天窗口的最新消息进行回复。',
        ctx.screenshot
      )
      if (!text || text.trim() === '[SKIP]') {
        yield { decision: { type: 'skip', reason: '[SKIP] sentinel or empty' } }
        return
      }
      yield { decision: { type: 'reply', text: text.trim() } }
    } catch (err) {
      log.error('VlmBrain.decide failed', { err })
      yield { decision: { type: 'skip', reason: err instanceof Error ? err.message : String(err) } }
    }
  }
}
```

---

## 4. Engine refactor

Constructor signature changes (intentional breaking change of the
**internal** API; nothing about the renderer/IPC surface changes):

```ts
// before:
new Engine(hooks: AgentHooks, device: DesktopDevice, onLog?, lifecycle?)
// after:
new Engine(brain: AgentBrain, device: DesktopDevice, hooks?: AgentHooks, onLog?, lifecycle?)
```

`processCurrentChat`:

```ts
const ctx: BrainContext = {
  appType: this.currentAppType,
  screenshot,
  traceId: this.currentTraceId
}
for await (const s of this.brain.decide(ctx)) {
  if (!this.running) break
  if (s.thinking) this.emitLog('thinking', s.thinking)
  if (s.decision) await this.executeDecision(s.decision)
}
```

`executeDecision` is a renamed/simplified `executeAction`:

- `'reply'` → `device.sendMessage` + `emitLog('reply')` + `hooks?.onActionComplete`
- `'skip'` → `emitLog('skip', reason)`

The legacy `executeAction(ReplyAction)` and the `'thinking' / 'image'`
branches go away. Image was a TODO with no implementation; we'll bring it
back as a `BrainDecision` variant when actually needed.

---

## 5. Hooks slim-down

`AgentHooks.getReply` is removed. The interface becomes:

```ts
export interface AgentHooks {
  onEngineStart?(): Promise<void>
  onEngineStop?(): Promise<void>
  executeActions?(params): AsyncIterable<ActionResult>
  onExternalTrigger?(callback): void
  onActionComplete?(action, result): void
  onError?(error, phase): void
}
```

`LocalHooks`:

- Drops `aiClient`, `LocalHooksConfig`, `updateAIConfig`, the entire
  `getReply` method, and the `console.warn('没有截图')` branch (now lives
  in `VlmBrain`).
- Keeps `onEngineStart` (which was just the testConnection log) — but the
  testConnection call itself moves to `VlmBrain.testConnection`. Main can
  call `brain.testConnection()` directly during boot if it wants the
  log; `LocalHooks` no longer owns it.

---

## 6. Main process integration

```ts
const provider = new OpenAICompatProvider({
  apiKey: config.apiKey,
  model: config.model ?? DEFAULT_MODEL,
  baseURL: config.baseURL ?? DEFAULT_BASE_URL
})
const brain = new VlmBrain({ provider, systemPrompt: config.systemPrompt })
const device = new RPADevice()
device.setAppType(config.appType ?? 'weixin')
device.setApiKey(config.apiKey) // stays — RPADevice still needs AIClient for VLM area detection
const localHooks = new LocalHooks()

engine = new Engine(brain, device, localHooks, onLogCb /* lifecycle */)
```

`engine:updateConfig` moves from `localHooks.updateAIConfig` to
`currentBrain.updateConfig`. `engine:testConnection` switches from `new
AIClient(...)` to `new OpenAICompatProvider(...).testConnection()` (one-line
change, same wire format).

---

## 7. Test plan

| Module                             | Coverage target                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `brain/providers/openai-compat.ts` | ≥ 90% (delegates to AIClient; tests focus on contract conformance + edge cases) |
| `brain/vlm-brain.ts`               | 100% (small surface, every branch in `decide` covered)                          |
| `engine.ts`                        | ≥ 75% (existing 11 tests adapt to FakeBrain; add 1 thinking-stream test)        |
| `local-hooks.ts`                   | ≥ 60% (smaller surface; delete obsolete getReply/updateAIConfig tests)          |

New tests (estimated):

- `openai-compat.test.ts` — 4 tests (callVision, callText, testConnection success/fail, updateConfig forwarded)
- `vlm-brain.test.ts` — ~8 tests (empty screenshot, [SKIP] sentinel, empty response, normal reply, custom system prompt, provider exception, updateConfig propagates, testConnection delegates)
- `engine.test.ts` — refactor existing 11 tests to use `makeFakeBrain` instead of `makeFakeHooks`. Add 1 test asserting that `BrainStream.thinking` lands in `emitLog('thinking', …)`.

---

## 8. Out of scope (deferred)

- **Provider implementations beyond OpenAI-compat** — Anthropic / Ollama
  added when the user actually needs them.
- **`BrainMemory`** — interface placeholder is _not_ added in this PR.
  When we wire memory in, we'll likely change `BrainContext` to include
  a `memory` snapshot, which is breaking. Better to wait for a real
  consumer.
- **`BrainTool` registration** — same reasoning; future Agent will need
  a richer tool schema and we don't want to commit to one prematurely.
- **Migration of `RPADevice`'s direct `AIClient` usage** to a provider —
  that's an RPA-leaf concern, not a brain concern. Phase 4 (Wechat
  scenario refactor) is the right time.
- **Watchdog / auto-restart** — still parked. Will land alongside Phase 3
  Anti-Detection so it can hook into the new policy/circuit-breaker
  components.
