import type { AgentBrain, BrainConfig, BrainContext, BrainStream } from './types'
import type { ChatProvider, ChatProviderConfig } from './providers/types'
import { getLogger } from '../observability'

const log = getLogger('brain.vlm')

/**
 * Default reply system prompt. Mirrors the prompt that lived inline in
 * `ai-client.ts` before Phase 2 — kept verbatim to preserve behaviour for
 * existing users who migrated their settings.
 */
export const DEFAULT_REPLY_SYSTEM_PROMPT = `你是一个微信自动回复助手。你会收到一张微信/企业微信的聊天窗口截图。

## 你的任务
分析截图中的聊天内容，生成合适的回复。

## 规则
1. 只输出回复文字，不要解释、不要添加多余内容
2. **防自我循环**：仔细观察截图。聊天窗口中，右侧的气泡是"我"发送的。如果最后一条消息是右侧气泡（即"我"自己发送的），必须输出 [SKIP]
3. 如果最新消息是系统消息、群公告、红包、转账等非对话消息，输出 [SKIP]
4. 回复要简短、自然、口语化，一般不超过 30 字
5. 不要使用 emoji 或表情符号

## 输出格式
直接输出回复文字，例如：
好的，我等会儿过去
或者：
[SKIP]`

const DEFAULT_USER_PROMPT = '请根据截图中微信聊天窗口的最新消息进行回复。'

export interface VlmBrainOptions {
  provider: ChatProvider
  systemPrompt?: string
  userPrompt?: string
}

/**
 * Vision-Language brain. Single-shot per turn:
 *   screenshot → provider.callVision → text or [SKIP]
 *
 * `decide()` is an async iterable so future brains (memory + tools) can
 * stream multiple thinking events without changing the engine's loop. The
 * VLM brain emits exactly one thinking event followed by one decision.
 */
export class VlmBrain implements AgentBrain {
  private readonly provider: ChatProvider
  private systemPrompt: string
  private userPrompt: string

  constructor(opts: VlmBrainOptions) {
    this.provider = opts.provider
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_REPLY_SYSTEM_PROMPT
    this.userPrompt = opts.userPrompt ?? DEFAULT_USER_PROMPT
  }

  async *decide(ctx: BrainContext): AsyncIterable<BrainStream> {
    if (!ctx.screenshot) {
      log.warn('decide skipped: empty screenshot')
      yield { decision: { type: 'skip', reason: 'empty screenshot' } }
      return
    }

    yield { thinking: '正在分析聊天内容...' }

    let replyText: string
    try {
      replyText = await this.provider.callVision(this.systemPrompt, this.userPrompt, ctx.screenshot)
    } catch (err) {
      log.error('VlmBrain.decide provider call failed', { err, traceId: ctx.traceId })
      yield {
        decision: {
          type: 'skip',
          reason: err instanceof Error ? err.message : String(err)
        }
      }
      return
    }

    const trimmed = replyText?.trim() ?? ''
    if (!trimmed) {
      yield { decision: { type: 'skip', reason: 'empty response' } }
      return
    }
    if (trimmed === '[SKIP]') {
      yield { decision: { type: 'skip', reason: '[SKIP] sentinel' } }
      return
    }

    yield { decision: { type: 'reply', text: trimmed } }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    return this.provider.testConnection()
  }

  /**
   * Hot-reload partial config. Forwards LLM-protocol fields to the provider
   * and updates the local system prompt if a new one is supplied.
   */
  updateConfig(config: Partial<BrainConfig>): void {
    const providerPatch: Partial<ChatProviderConfig> = {}
    if (config.apiKey !== undefined) providerPatch.apiKey = config.apiKey
    if (config.model !== undefined) providerPatch.model = config.model
    if (config.baseURL !== undefined) providerPatch.baseURL = config.baseURL
    if (Object.keys(providerPatch).length > 0) {
      this.provider.updateConfig(providerPatch)
    }
    if (config.systemPrompt !== undefined && config.systemPrompt.length > 0) {
      this.systemPrompt = config.systemPrompt
    }
  }
}
