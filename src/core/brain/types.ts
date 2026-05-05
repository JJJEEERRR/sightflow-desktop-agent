import type { AppType } from '../rpa/types'

/**
 * Phase 2 — Brain abstraction public types.
 *
 * The brain is the "what should we say next" component. Today there is one
 * implementation (`VlmBrain`), which delegates to a Vision-Language Model
 * via a `ChatProvider`. Future implementations (`MemoryAgentBrain`,
 * `ToolAgentBrain`) will compose memory + tool calls and may emit multiple
 * thinking events before a final decision.
 *
 * Hooks (`AgentHooks`) own lifecycle/error/external-trigger callbacks; the
 * brain owns *just* the decision pipeline. Engine wires both.
 */

export interface BrainContext {
  /**
   * Application context — `weixin` / `wework` / `whatsapp`. Future brains
   * will pick prompt templates or memory stores per app.
   */
  appType: AppType
  /** Base64 PNG, may include or omit the `data:image/png;base64,` prefix. */
  screenshot: string
  /** Trace ID propagated from the engine's per-tick traceId for log correlation. */
  traceId?: string
  /**
   * Reserved for future memory/tool wiring. `VlmBrain` ignores this field
   * today; including it now keeps the BrainContext shape stable so adding
   * memory in a later phase is non-breaking.
   */
  history?: unknown[]
}

export type BrainDecision = { type: 'reply'; text: string } | { type: 'skip'; reason?: string }

/**
 * One step in the decision stream. Both fields are optional and may appear
 * independently — typically the brain emits any number of `thinking` events
 * followed by exactly one `decision`. The engine is robust to either field
 * being absent on a given step.
 */
export interface BrainStream {
  thinking?: string
  decision?: BrainDecision
}

export interface BrainConfig {
  apiKey: string
  model?: string
  baseURL?: string
  systemPrompt?: string
}

/**
 * The contract every brain implementation must satisfy. Engine never reaches
 * past these three methods.
 */
export interface AgentBrain {
  decide(ctx: BrainContext): AsyncIterable<BrainStream>
  testConnection(): Promise<{ success: boolean; error?: string }>
  updateConfig(config: Partial<BrainConfig>): void
}
