import { AIClient, type AIClientConfig } from '../../ai-client'
import type { ChatProvider, ChatProviderConfig } from './types'

/**
 * OpenAI-compatible chat provider. Wraps `AIClient` (which already speaks
 * `/chat/completions` with structured logging, abort/timeout handling, and
 * proper error propagation) so the brain layer doesn't depend on the
 * concrete client shape.
 *
 * Why not `ai-sdk`? See ADR 0006. The interface here is intentionally
 * shaped to be `ai-sdk`-compatible so a future swap is one file change.
 */
export interface OpenAICompatProviderOptions extends Partial<AIClientConfig> {
  apiKey: string
}

export class OpenAICompatProvider implements ChatProvider {
  private readonly client: AIClient

  constructor(opts: OpenAICompatProviderOptions) {
    this.client = new AIClient(opts)
  }

  async callVision(systemPrompt: string, userText: string, imageBase64: string): Promise<string> {
    return this.client.callVision(systemPrompt, userText, imageBase64)
  }

  async callText(message: string): Promise<string> {
    return this.client.callText(message)
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.client.testConnection()
  }

  updateConfig(config: Partial<ChatProviderConfig>): void {
    this.client.updateConfig(config)
  }
}
