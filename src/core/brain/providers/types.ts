/**
 * Phase 2 — Brain providers public types.
 *
 * `ChatProvider` is the protocol-level abstraction over an LLM endpoint:
 * "give it a system prompt + a user message (with optional image), get text
 * back". Brains compose providers; today there is one (`OpenAICompatProvider`),
 * but the shape is intentionally narrow so we can drop in `ai-sdk`,
 * `@anthropic-ai/sdk`, or a local mock without touching the brain layer.
 *
 * See ADR 0006 for the rationale on staying off `ai-sdk` for now.
 */

export interface ChatProviderConfig {
  apiKey: string
  model: string
  baseURL: string
}

export interface ChatProvider {
  /**
   * Sends a system prompt + user text + base64 image to the model and returns
   * the assistant text. Throws on transport / HTTP / parse failure.
   */
  callVision(systemPrompt: string, userText: string, imageBase64: string): Promise<string>

  /** Pure text completion — used today only for `testConnection` style probes. */
  callText(message: string): Promise<string>

  /**
   * Health check. Returns `{success: false, error: string}` for any auth /
   * transport failure rather than throwing, so settings UIs can surface it
   * without wrapping in try/catch.
   */
  testConnection(): Promise<{ success: boolean; error?: string }>

  /** Hot-reload partial config. Unspecified fields keep their previous values. */
  updateConfig(config: Partial<ChatProviderConfig>): void
}
