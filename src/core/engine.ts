// src/core/engine.ts
// 主引擎循环 — 微信自动回复的完整感知→决策→执行闭环
//
// 流程:
// 1. 启动 — 初始化 hooks + 权限 OK
// 2. 测量 — VLM 一次性定位布局（chatEntrance / firstContact / inputArea），结果缓存
// 3. 发图 — 截图当前对话
// 4. 回复 — AI 分析截图内容 + RPA 执行回复
// 5. 检查下一条 — 纯视觉红点检测 + 点击切换
//    → 有未读: 视觉点击红点 → 细检测联系人 → 点击联系人，回到步骤 3
//    → 无未读: 轮询等待，直到新消息出现

import { AgentHooks, ReplyAction, ActionItem } from './hooks'
import { DesktopDevice } from './device'
import { getLogger, newTraceId, type Logger } from './observability'
import { Lifecycle, type LifecycleState } from './runtime'

export class Engine {
  private running = false
  private consecutiveUnreadFailures = 0
  private readonly log: Logger
  private readonly lifecycle: Lifecycle
  private currentTraceId: string | undefined

  constructor(
    private hooks: AgentHooks,
    private device: DesktopDevice,
    private onLog?: (type: string, content: string) => void,
    lifecycle?: Lifecycle
  ) {
    this.lifecycle = lifecycle ?? new Lifecycle()
    this.log = getLogger('engine')
  }

  /**
   * Returns the engine's lifecycle. Main process subscribes to its events to
   * propagate state to the renderer and drive `powerSaveBlocker`.
   */
  getLifecycle(): Lifecycle {
    return this.lifecycle
  }

  /**
   * Bridges the legacy renderer-facing log channel and the structured logger.
   * The legacy `engine:log` IPC payload (type, content) is preserved for the
   * current UI; the same record is also fanned out to all configured
   * observability sinks (file, ring buffer, console in dev).
   */
  private emitLog(type: 'thinking' | 'reply' | 'skip' | 'error', content: string): void {
    if (this.onLog) this.onLog(type, content)
    const child = this.log.child(`engine.${type}`, this.currentTraceId)
    if (type === 'error') child.error(content)
    else child.info(content)
  }

  /** Safely transitions the lifecycle to a terminal stop, ignoring illegal-from states. */
  private safeStopLifecycle(): void {
    const state: LifecycleState = this.lifecycle.getState()
    if (state === 'running' || state === 'paused' || state === 'crashed') {
      this.lifecycle.stop()
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    if (this.lifecycle.getState() === 'idle') {
      this.lifecycle.start()
    }
    await this.hooks.onEngineStart?.()

    this.hooks.onExternalTrigger?.((params) => {
      this.executeExternalActions(params)
    })

    try {
      // ── Step 1: 测量 ──
      this.emitLog('thinking', '开始布局测量...')
      const measureResult = await this.device.measureLayout()

      if (!measureResult.success) {
        const reason = measureResult.error || '布局测量失败'
        this.emitLog('error', `${reason}，引擎无法启动`)
        if (this.lifecycle.getState() === 'running') {
          this.lifecycle.crash(new Error(reason))
        }
        this.running = false
        await this.hooks.onEngineStop?.()
        return
      }

      this.emitLog('thinking', '布局测量完成 ✓')

      // ── 主循环 ──
      while (this.running) {
        // Allocate a fresh traceId per tick so emitLog/logger calls are correlatable.
        this.currentTraceId = newTraceId()
        try {
          await this.processCurrentChat()

          if (!this.running) break

          await this.waitForNextUnread()
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          this.emitLog('error', `循环异常: ${err.message}`)
          this.hooks.onError?.(err, 'engine_loop')
          await this.sleep(3000 + Math.random() * 2000)
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.emitLog('error', `引擎启动失败: ${err.message}`)
      this.hooks.onError?.(err, 'engine_start')
      if (this.lifecycle.getState() === 'running') {
        this.lifecycle.crash(err)
      }
    } finally {
      this.currentTraceId = undefined
    }

    await this.hooks.onEngineStop?.()
    // If the loop exited normally (stop() flipped `this.running`), the lifecycle
    // was already moved to 'stopped' by stop(). If we're still in 'running' here
    // (e.g. measureLayout returned without success but didn't crash), do a
    // graceful stop so observers see a terminal state.
    if (this.lifecycle.getState() === 'running') {
      this.lifecycle.stop()
    }
  }

  stop(): void {
    this.running = false
    this.safeStopLifecycle()
    this.device.clearChatBaseline()
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Allow external orchestrators (e.g. the main-process IPC handlers) to update
   * the engine's target application type without reaching into private fields.
   */
  setAppType(appType: Parameters<DesktopDevice['setAppType']>[0]): void {
    this.device.setAppType(appType)
  }

  // ── Step 3+4: 发图 → 回复 ──

  /**
   * 处理当前对话：截图 → AI 分析 → RPA 执行回复 → 设置 diff baseline
   */
  private async processCurrentChat(): Promise<void> {
    // 发图
    const screenshot = await this.device.screenshot()
    this.emitLog('thinking', '截图完成，请求 AI 分析...')

    // 回复
    for await (const action of this.hooks.getReply({ screenshot })) {
      if (!this.running) break
      await this.executeAction(action)
    }

    // 回复完成后，保存 chatMainArea 截图作为 diff baseline
    // 这样后续轮询时可以检测当前对话窗口是否有新消息
    if (this.running) {
      await this.device.setChatBaseline()
    }
  }

  // ── Step 5: 双通道检测（红点 + chatMainArea diff） ──

  /**
   * 等待下一条消息（红点检测 + chatMainArea diff 双通道并行）
   *
   * 通道 1 — 红点检测：检测左侧列表的未读角标（其他联系人发消息）
   * 通道 2 — chatMainArea diff：检测当前对话窗口是否有变化（当前联系人发消息）
   *
   * 为什么需要双通道：
   * - 红点检测只能发现 **其他联系人** 的新消息（左侧列表出现红点）
   * - 但 **当前打开的对话** 收到新消息时，左侧不会出现红点
   * - chatMainArea diff 弥补了这个盲点
   *
   * 流程：
   * 1. 每轮轮询先检查 chatMainArea diff
   * 2. diff 有变化 → 直接 return（当前对话有新消息，回到 processCurrentChat）
   * 3. diff 无变化 → 检查红点
   * 4. 红点有未读 → 视觉点击切换联系人 → return
   */
  private async waitForNextUnread(): Promise<void> {
    while (this.running) {
      // 轮询间隔 3-5 秒
      await this.sleep(3000 + Math.random() * 2000)

      if (!this.running) break

      // ── 通道 2: chatMainArea diff 检测 ──
      const diffResult = await this.device.hasChatAreaChanged()

      if (diffResult.hasDiff) {
        this.emitLog('thinking', '检测到当前对话有新消息（chatMainArea diff）')
        // 当前对话有变化 → 直接回到 processCurrentChat
        return
      }

      // ── 通道 1: 粗检测红点 ──
      const unreadResult = await this.device.hasUnreadMessage()

      if (!unreadResult.hasUnread) {
        // 两个通道都没有新消息，继续轮询
        continue
      }

      // ── Step 2: 点击红点区域激活未读列表 ──
      const redDotCoordinates = unreadResult.chatEntranceArea?.coordinates
      if (!redDotCoordinates) {
        this.emitLog('error', '检测到未读但未获取到 chatEntranceArea 坐标，继续轮询')
        continue
      }

      this.emitLog(
        'thinking',
        `检测到未读消息，点击红点区域 (${redDotCoordinates[0]}, ${redDotCoordinates[1]})`
      )
      await this.device.activeUnreadByClick(redDotCoordinates)
      await this.sleep(150 + Math.random() * 100)

      // ── Step 3: 细检测联系人红点 ──
      let contactResult = await this.device.isChatContactUnread()

      // ── Step 3.1: 首次细检测失败 → 重新粗检测 + 再次点击 ──
      if (!contactResult.isUnread) {
        this.emitLog('thinking', '当前联系人无未读消息，重新检测...')
        await this.sleep(1000)

        const recheckResult = await this.device.hasUnreadMessage()

        if (recheckResult.hasUnread) {
          this.emitLog('thinking', '仍有未读消息，再次点击红点')

          const recheckCoords = recheckResult.chatEntranceArea?.coordinates
          if (recheckCoords) {
            await this.device.activeUnreadByClick(recheckCoords)
            await this.sleep(500)

            // 再次细检测
            contactResult = await this.device.isChatContactUnread()
          }
        } else {
          this.emitLog('skip', '重新检测后无未读消息，继续轮询')
          continue
        }
      }

      // ── Step 3.2: 连续两次细检测失败 → 增加失败计数，达到阈值再清除缓存强制重检 ──
      if (!contactResult.isUnread) {
        this.consecutiveUnreadFailures++

        if (this.consecutiveUnreadFailures >= 3) {
          this.emitLog(
            'thinking',
            `连续 ${this.consecutiveUnreadFailures} 次检测失败，VLM 坐标缓存可能不准确，清除缓存强制重检`
          )
          this.device.clearUnreadCache()
          this.consecutiveUnreadFailures = 0 // 重置
          await this.sleep(500)

          // 重新调 isChatContactUnread（触发 VLM 重新定位 firstContact）
          contactResult = await this.device.isChatContactUnread()

          if (!contactResult.isUnread) {
            // 缓存重建后仍失败 → 再点击一次 + 最终检测
            this.emitLog('thinking', '缓存重建后检测失败，再点击一次')

            const retryUnread = await this.device.hasUnreadMessage()
            const retryCoords = retryUnread.chatEntranceArea?.coordinates

            if (retryCoords) {
              await this.device.activeUnreadByClick(retryCoords)
              await this.sleep(500)

              contactResult = await this.device.isChatContactUnread()

              if (!contactResult.isUnread) {
                this.emitLog('skip', '最终检测仍失败，放弃，继续轮询')
                continue
              }
            } else {
              this.emitLog('skip', '缓存重建后未获取到坐标，继续轮询')
              continue
            }
          }
        } else {
          this.emitLog(
            'skip',
            `细检测失败 (第 ${this.consecutiveUnreadFailures} 次)，暂不清除缓存，继续轮询`
          )
          continue
        }
      }

      // 重置失败计数
      this.consecutiveUnreadFailures = 0

      // ── Step 4: 点击未读联系人 ──
      const firstContactCoords = contactResult.firstContactCoords
      if (!firstContactCoords) {
        this.emitLog('skip', '未获取到 firstContact 坐标，继续轮询')
        continue
      }

      this.emitLog('thinking', `点击联系人 (${firstContactCoords[0]}, ${firstContactCoords[1]})`)
      await this.device.clickUnreadContact(firstContactCoords)
      await this.sleep(500 + Math.random() * 300)

      // 切换了联系人 → 清除旧 baseline（新对话需要新的 baseline）
      this.device.clearChatBaseline()

      // 成功切换 → 回到主循环 processCurrentChat
      return
    }
  }

  // ── 执行动作 ──

  private async executeAction(action: ReplyAction): Promise<void> {
    try {
      switch (action.type) {
        case 'text':
          this.emitLog('reply', `[回复] ${action.content}`)
          await this.device.sendMessage(action.content)
          this.hooks.onActionComplete?.({ type: 'text', content: action.content } as ActionItem, {
            success: true
          })
          break
        case 'image':
          // TODO: 图片发送
          break
        case 'thinking':
          this.emitLog('thinking', action.content)
          break
        case 'skip':
          this.emitLog('skip', '跳过回复')
          break
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      this.emitLog('error', `执行动作失败: ${err.message}`)
      this.hooks.onError?.(err, 'execute_action')
    }
  }

  private async executeExternalActions(params: {
    actions: ActionItem[]
    targets?: string[]
  }): Promise<void> {
    if (this.hooks.executeActions) {
      for await (const result of this.hooks.executeActions(params)) {
        this.log.info('External action result', {
          result: result as unknown as Record<string, unknown>
        })
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
