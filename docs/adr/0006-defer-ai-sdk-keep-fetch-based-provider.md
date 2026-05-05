# ADR 0006 — Defer `ai-sdk`, keep fetch-based provider for now

- **Status**: Accepted
- **Date**: 2026-05-05
- **Decider**: Cursor agent (autonomous), per user delegation
- **Supersedes**: nothing
- **Related**: `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md` §3.3

## Context

Phase 2 introduces a `ChatProvider` abstraction inside `core/brain/providers/`.
The original spec (§6 Phase 2) proposed implementing the OpenAI-compatible
provider on top of Vercel's `ai-sdk` package (`ai`).

When implementing the provider, we evaluated whether to:

1. Adopt `ai-sdk` immediately (per the spec's parenthetical note), or
2. Wrap the existing `AIClient` (which already speaks OpenAI-compatible
   `/chat/completions`) and defer the `ai-sdk` migration.

## Decision

**Defer `ai-sdk` adoption.** `OpenAICompatProvider` is a thin wrapper around
the existing `AIClient`. The `ChatProvider` interface is intentionally shaped
to be `ai-sdk`-compatible so the swap is mechanical when we do it.

## Why

- `AIClient` already covers everything `VlmBrain` needs: streaming-free
  chat completions, structured logging through the new observability
  module, abort/timeout handling, structured error reporting, and 12
  passing unit tests against mocked `fetch`.
- `ai-sdk` is ESM-only with non-trivial CJS interop quirks. Phase 0 burned
  ~half a day on similar `electron-store` ESM/CJS issues. Adding a new
  ESM-only dep in a Brain-abstraction PR mixes concerns and risks
  destabilising the main process bundle.
- The whole point of `ChatProvider` is that the brain doesn't care which
  underlying client speaks the protocol. We get the abstraction's benefit
  (swap-ability) without committing to a specific dep right now.
- Deferring also gives us time to evaluate the alternatives — `ai-sdk`,
  `@anthropic-ai/sdk`, hand-rolled `fetch` against multiple endpoints —
  in the context of Phase 3+ where multi-provider support actually
  matters (Anthropic for safety, Ollama for offline, etc.).

## Consequences

**Positive**

- Phase 2 PR stays scoped to "Brain abstraction" — no dep changes, no
  bundler surprises, no rebuild matrix expansion.
- `ChatProvider`'s shape (`callVision / callText / testConnection /
updateConfig`) is small enough that swapping in `ai-sdk` later is one
  file change (`openai-compat.ts`) plus its test.
- We keep our existing structured logging story intact (every LLM call
  goes through `getLogger('ai-client')` → all 4 sinks).

**Negative**

- We aren't yet using a battle-tested SDK; `AIClient`'s OpenAI-compat
  implementation is hand-rolled. (Mitigation: 12 unit tests, ~92% line
  coverage; the surface is small.)
- A future "swap to `ai-sdk`" PR will need to replicate the same
  observability hooks. (Mitigation: the swap is one file. We'll write a
  brief note in `tests/README.md` when the time comes.)

## Alternatives considered

- **Adopt `ai-sdk` immediately**: Rejected — see context above. Mixes
  concerns and risks bundler regression in a refactoring PR.
- **Skip the provider abstraction entirely; let VlmBrain hold AIClient
  directly**: Rejected — defeats the point of Phase 2. Future
  Anthropic/Ollama brains would have to either re-build the abstraction
  or fork VlmBrain.
- **Implement `OpenAICompatProvider` with raw `fetch` instead of wrapping
  `AIClient`**: Rejected — would duplicate the timeout/abort/logging code
  that's already in `AIClient`. Wrapping is leaner.
