// src/core/local-hooks.ts
// LocalHooks — AgentHooks 的本地实现
//
// 用 AIClient 直接调用豆包模型，替代旧项目的 WebSocket + 后端服务。
// v0.1: 无聊天历史、无知识库、无定时任务。纯粹的 截图→AI回复→RPA打字。

import { AgentHooks, MessageContext, ReplyAction, ActionItem, ActionResult } from './hooks'
import { AIClient, AIClientConfig } from './ai-client'
import { getLogger } from './observability'

const log = getLogger('hooks.local')

export interface LocalHooksConfig {
  ai: Partial<AIClientConfig> & { apiKey: string }
}

export class LocalHooks implements AgentHooks {
  private aiClient: AIClient

  constructor(config: LocalHooksConfig) {
    this.aiClient = new AIClient(config.ai)
  }

  async onEngineStart(): Promise<void> {
    log.info('Engine started')

    const testResult = await this.aiClient.testConnection()
    if (!testResult.success) {
      log.error('AI API connection check failed', { reason: testResult.error })
      // Non-blocking — boot continues so the user can fix the API key in settings.
    } else {
      log.info('AI API 连接正常')
    }
  }

  async onEngineStop(): Promise<void> {
    log.info('Engine stopped')
  }

  /**
   * 核心方法：检测到新消息后，拿截图问 AI，返回回复 action
   *
   * 流程：
   * 1. 收到 MessageContext（包含截图）
   * 2. 发送截图给 AI
   * 3. AI 返回回复文字
   * 4. yield { type: 'text', content: '回复内容' }
   * 5. Engine 收到后调用 device.sendMessage() 执行 RPA 打字
   */
  async *getReply(context: MessageContext): AsyncIterable<ReplyAction> {
    if (!context.screenshot) {
      log.warn('getReply skipped: empty screenshot')
      yield { type: 'skip' }
      return
    }

    yield { type: 'thinking', content: '正在分析聊天内容...' }

    try {
      const reply = await this.aiClient.getReply(context.screenshot)

      if (!reply) {
        yield { type: 'skip' }
        return
      }

      yield { type: 'text', content: reply }
    } catch (error) {
      log.error('AI reply failed', { err: error })
      yield { type: 'skip' }
    }
  }

  /**
   * 执行外部触发的动作列表（主动任务）
   * v0.1: 简单实现，逐个执行
   */
  async *executeActions(params: {
    actions: ActionItem[]
    targets?: string[]
  }): AsyncIterable<ActionResult> {
    for (const action of params.actions) {
      try {
        // 对每个 action，直接 yield 成功
        // Engine 负责调用 device 执行实际操作
        yield { action, success: true }
      } catch (error) {
        yield {
          action,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  onActionComplete(action: ActionItem, result: { success: boolean }): void {
    log.info('Action completed', { type: action.type, success: result.success })
  }

  onError(error: Error, phase: string): void {
    log.error(`Error in ${phase}`, { err: error })
  }

  /**
   * 更新 AI 配置（用户在设置页修改后调用）
   */
  updateAIConfig(config: Partial<AIClientConfig>): void {
    this.aiClient.updateConfig(config)
  }
}
