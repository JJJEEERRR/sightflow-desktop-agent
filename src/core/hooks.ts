// src/core/hooks.ts
// AgentHooks — 引擎对外的回调集合（生命周期 / 错误 / 外部触发）。
//
// Phase 2 起，"看到截图 → 决定怎么回复" 的职责迁移到 `core/brain/AgentBrain`。
// Hooks 只保留与 brain 无关的回调点，方便插件挂载日志、指标、外部任务调度等。

export interface AgentHooks {
  // === 生命周期 ===
  onEngineStart?(): Promise<void>
  onEngineStop?(): Promise<void>

  // === 主动：外部触发执行一组操作 ===
  executeActions?(params: {
    actions: ActionItem[]
    targets?: string[]
  }): AsyncIterable<ActionResult>

  // === 调度：外部系统注册触发器（定时任务等） ===
  onExternalTrigger?(
    callback: (params: { actions: ActionItem[]; targets?: string[] }) => void
  ): void

  // === 回调 ===
  onActionComplete?(action: ActionItem, result: { success: boolean }): void
  onError?(error: Error, phase: string): void
}

// 通用消息上下文。Phase 2 之后供历史/调试用途，不再驱动 brain 决策。
export interface MessageContext {
  screenshot: string // base64 截图
  currentContact?: string
}

// 通用回复动作（保留以便 executeActions 复用）
export type ReplyAction =
  | { type: 'text'; content: string }
  | { type: 'image'; url: string }
  | { type: 'thinking'; content: string }
  | { type: 'skip' }

// 通用执行动作
export type ActionItem =
  | { type: 'text'; content: string }
  | { type: 'image'; url: string }
  | { type: 'search_contact'; name: string }
  | { type: 'wait'; ms: number }

// 执行结果
export interface ActionResult {
  action: ActionItem
  success: boolean
  error?: string
}
