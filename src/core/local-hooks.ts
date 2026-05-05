// src/core/local-hooks.ts
// LocalHooks — AgentHooks 的本地实现
//
// Phase 2 之后，brain 决策由 `core/brain/VlmBrain` 负责。LocalHooks 只承担
// 引擎对外的生命周期 / 错误 / executeActions 回调。AI 客户端配置改由
// `VlmBrain.updateConfig` 接管，main 进程直接持有 brain 实例。

import { AgentHooks, ActionItem, ActionResult } from './hooks'
import { getLogger } from './observability'

const log = getLogger('hooks.local')

export class LocalHooks implements AgentHooks {
  async onEngineStart(): Promise<void> {
    log.info('Engine started')
  }

  async onEngineStop(): Promise<void> {
    log.info('Engine stopped')
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
        // Engine 真正负责调用 device 执行；此处只做记账。
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
}
