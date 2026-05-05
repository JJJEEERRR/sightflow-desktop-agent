# Phase 2 — Brain Abstraction: Execution Log

> Companion to `docs/superpowers/plans/2026-05-05-phase2-brain-abstraction.md`
> and ADR `0006-defer-ai-sdk-keep-fetch-based-provider.md`. Records every
> decision and pivot during autonomous execution so future agents can rebuild
> context without replaying the chat.

---

## 2026-05-05 — Decisions made up front

Three design questions had to be answered before touching code:

1. **Should `Engine.isRunning()` derive from a brain state?**

   Decided: **No**. Brain has no state of its own; it's a pure decision
   function. `Engine.running` (boolean) and `Engine.lifecycle` (FSM) keep
   their roles from Phase 1.

2. **Should `AgentHooks.getReply` survive as a no-op or be deleted
   outright?**

   Decided: **Delete**. Spec §6 says "Engine 改为消费 AgentBrain
   (不改外部行为)"; "外部行为" refers to user-visible behaviour, not the
   internal hooks contract. Keeping `getReply` as a vestigial method
   would obscure the new architecture and risk silent fallback paths.

3. **Should we adopt Vercel `ai-sdk` for the OpenAI-compat provider?**

   Decided: **No, defer**. Existing `AIClient` covers everything we need,
   has structured logging baked in (Phase 1), and adding an ESM-only
   dependency in a Brain-abstraction PR mixes concerns. ADR
   `0006-defer-ai-sdk-keep-fetch-based-provider.md` records the
   rationale; the swap is a one-file change when we do it.

---

## 2026-05-05 — Module sequencing

Implementation order was chosen to minimise broken intermediate states:

1. Add public `callVision` to `AIClient` (small additive change).
2. Build the new `core/brain/` tree end-to-end, **with tests**, while the
   rest of the codebase still works (existing `AgentHooks.getReply` path
   intact). This let us validate the new layer in isolation: 18 brain
   tests passing before any caller migrated.
3. Slim `hooks.ts` (drop `getReply`, drop `MessageContext.ocrText` field
   that was a TODO since 2024).
4. Slim `local-hooks.ts` (drop `aiClient`, drop `LocalHooksConfig`,
   drop `updateAIConfig`). Reduced from ~115 lines to 50.
5. Refactor `engine.ts` (constructor signature change, `processCurrentChat`
   reads from `brain.decide`, `executeAction` → `executeDecision`).
6. Update `main/index.ts` to wire `OpenAICompatProvider + VlmBrain` into
   `Engine` and reroute `engine:updateConfig` / `engine:testConnection`.
7. Update existing tests; add new tests last.

---

## 2026-05-05 — Tricky implementation details

### `BrainStream` is intentionally permissive

Both `thinking` and `decision` are optional on every `BrainStream`. The
engine handles any combination (thinking-only, decision-only, both, or
empty). This freedom matters because future memory/tool brains will emit
many partial events before a final decision; we don't want to commit to
a strict thinking-then-decision ordering.

The unit test for VlmBrain explicitly asserts `events.length === 2`
(one thinking, one decision) so we catch any accidental breakage of the
single-shot contract for _that_ implementation.

### `updateConfig` empty-string guard

`VlmBrain.updateConfig({ systemPrompt: '' })` is a _no-op_ — it does NOT
clobber the existing prompt. This protects the IPC path
(`engine:updateConfig`) where settings UI may send `''` for unset fields
because `electron-store` returns `''` for missing keys. Test
`'ignores empty systemPrompt patches'` pins this contract.

### Engine constructor positional reshuffle

The old shape was `(hooks, device, onLog?, lifecycle?)`. The new is
`(brain, device, hooks?, onLog?, lifecycle?)`. Brain replaces hooks as
the primary required argument because:

- Engine cannot operate without a brain (every tick calls `decide`).
- Engine _can_ operate with empty hooks (lifecycle/error callbacks all
  use `?.`).

This forces every existing call-site to update — there's no silent
backwards compat. We wanted that: a half-migrated engine with the old
hooks-first signature would silently still work and never emit errors,
which is the worst kind of regression.

### Test fixture compatibility shim

`makeFakeBrain` accepts `ReplyAction[][]` (the legacy fixture shape)
and translates each into a `BrainStream`. This kept the 11 existing
engine tests at near-zero churn — only the call-site changes
(`new Engine(hooks, device)` → `new Engine(brain, device, hooks)` plus
splitting `makeFakeHooks([…])` into `makeFakeBrain([…]) +
makeFakeHooks()`).

The `'image'` ReplyAction translates to `{}` (empty stream step). Pre-Phase-2
the Engine had a TODO no-op for image, and no test exercised it, so the
behaviour is unchanged.

---

## 2026-05-05 — Quality gates

| Gate                    | Result                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`          | 0 errors, 0 warnings (after one auto-fix sweep for prettier)                                                                                      |
| `npm run typecheck`     | clean (node + web)                                                                                                                                |
| `npm test`              | **217 / 217** pass (was 199 in Phase 1; +6 OpenAICompatProvider, +12 VlmBrain, +2 Engine.brain integration, –2 obsolete LocalHooks tests deleted) |
| `npm run test:coverage` | 54.77% lines · 88.71% branches · 75.97% functions (above 50% global floor)                                                                        |
| `npm run build`         | preload + renderer chunks emit without errors                                                                                                     |

New module coverage: `brain/types.ts` 100% (interface only) · `brain/vlm-brain.ts` 100% · `brain/providers/openai-compat.ts` 100%.

---

## What is intentionally not in this PR

- **`BrainMemory` interface** — placeholder only in the spec; we'll add it
  with the first real consumer (Phase ?). Adding it now risks fixing the
  shape too early.
- **`BrainTool` interface** — same reasoning.
- **Multi-provider support (Anthropic, Ollama)** — the abstraction is
  ready; we'll add concrete providers when there's a real use case.
- **Migration of `RPADevice`'s direct `AIClient` usage** to a provider —
  RPA-leaf concern, parked for Phase 4 (Wechat scenario refactor).
- **Watchdog / auto-restart** — still parked for Phase 3 alongside
  Anti-Detection (so it can compose with the new policy/circuit-breaker
  components). `Lifecycle.recover()` remains fully implemented and
  unit-tested but uncalled.
