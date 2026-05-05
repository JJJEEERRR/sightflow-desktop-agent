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

import { AgentHooks, ActionItem } from './hooks'
import { DesktopDevice } from './device'
import { getLogger, newTraceId, type Logger } from './observability'
import { Lifecycle, type LifecycleState } from './runtime'
import type { AgentBrain, BrainContext, BrainDecision } from './brain'
import type { AntiDetectionPolicy } from './policy'
import type { AppType } from './rpa/types'

export class Engine {
  private running = false
  private consecutiveUnreadFailures = 0
  private readonly log: Logger
  private readonly lifecycle: Lifecycle
  private currentTraceId: string | undefined
  private currentAppType: AppType = 'weixin'

  /**
   * Phase 2 constructor signature: `brain` is the decision-making component
   * (replaces the former `hooks.getReply`). `hooks` is now optional and only
   * carries lifecycle/error/external-trigger callbacks.
   *
   * Phase 3 adds an optional `policy` that the engine consults before every
   * tick (rate-limit, schedule window, circuit breaker) and around every
   * device action (humanizer pre/post delays, jitter, breaker observation).
   * The argument is optional so existing tests and the Phase-2 code path keep
   * working unchanged.
   */
  constructor(
    private brain: AgentBrain,
    private device: DesktopDevice,
    private hooks: AgentHooks = {},
    private onLog?: (type: string, content: string) => void,
    lifecycle?: Lifecycle,
    private policy?: AntiDetectionPolicy
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
    // Capture the lifecycle state at entry so we can tell whether this is a
    // fresh start (idle) or a Watchdog-driven recovery (recovering). The
    // handshake matters: the Watchdog has already moved us to `recovering`,
    // and we are responsible for transitioning back to `running` only once
    // measureLayout actually succeeds.
    const startState = this.lifecycle.getState()
    if (startState === 'idle') {
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
        // crash() is legal from both 'running' and 'recovering' so this
        // works whether we got here via a fresh start or a watchdog retry.
        const state = this.lifecycle.getState()
        if (state === 'running' || state === 'recovering') {
          this.lifecycle.crash(new Error(reason))
        }
        this.running = false
        await this.hooks.onEngineStop?.()
        return
      }

      this.emitLog('thinking', '布局测量完成 ✓')

      // Watchdog-driven recovery handshake: we entered start() in
      // 'recovering' (the Watchdog called lifecycle.recover()). Now that
      // bootstrap succeeded, declare ourselves back online. If the user
      // stopped us mid-bootstrap we'll have moved to 'stopped' already
      // and skip the transition.
      if (startState === 'recovering' && this.lifecycle.getState() === 'recovering') {
        this.lifecycle.recovered()
      }

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
      const state = this.lifecycle.getState()
      if (state === 'running' || state === 'recovering') {
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
   * Engine also keeps a local copy so the value can be plumbed into
   * `BrainContext` without round-tripping through the device.
   */
  setAppType(appType: AppType): void {
    this.currentAppType = appType
    this.device.setAppType(appType)
  }

  // ── Step 3+4: 发图 → 回复 ──

  /**
   * 处理当前对话：截图 → brain 决策 → RPA 执行回复 → 设置 diff baseline
   *
   * Phase 2 起，"看到截图、决定怎么回复" 的职责完全交给 `AgentBrain`。
   * 引擎只负责：
   *   - 截图、把上下文打包成 `BrainContext`
   *   - 把 brain 流式输出的 `thinking` / `decision` 路由到 emitLog / 设备调用
   *   - 维护 chatMainArea diff baseline
   */
  private async processCurrentChat(): Promise<void> {
    // ── Phase 3: anti-detection gate ────────────────────────────────────
    if (this.policy) {
      const gate = await this.policy.beforeReply()
      if (!gate.proceed) {
        if (gate.pause) {
          // Circuit breaker tripped — pause the lifecycle and exit the loop.
          // The user must explicitly resume; the watchdog never auto-recovers
          // a 'paused' state, only 'crashed'.
          this.emitLog('skip', `策略拒绝执行（${gate.reason}），暂停引擎：${gate.pause.detail}`)
          if (this.lifecycle.getState() === 'running') {
            this.lifecycle.pause(gate.pause.reason)
          }
          this.running = false
          return
        }
        // Soft block (rate-limit, schedule out-of-window). Sleep and skip
        // this tick; the next loop iteration re-evaluates.
        this.emitLog('skip', `策略稍后再试（${gate.reason}），等待 ${gate.waitMs}ms`)
        await this.cancellableSleep(gate.waitMs)
        return
      }
    }

    const screenshot = await this.device.screenshot()
    this.emitLog('thinking', '截图完成，请求 AI 分析...')

    const ctx: BrainContext = {
      appType: this.currentAppType,
      screenshot,
      traceId: this.currentTraceId
    }

    let sawDecision = false
    try {
      for await (const stream of this.brain.decide(ctx)) {
        if (!this.running) break
        if (stream.thinking) {
          this.emitLog('thinking', stream.thinking)
        }
        if (stream.decision) {
          sawDecision = true
          await this.executeDecision(stream.decision)
        }
      }
      if (sawDecision) this.policy?.observe({ type: 'aiSuccess' })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.policy?.observe({ type: 'aiFailure', err: e })
      throw e
    }

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

  // ── 执行 brain 决策 ──

  private async executeDecision(decision: BrainDecision): Promise<void> {
    try {
      switch (decision.type) {
        case 'reply': {
          this.emitLog('reply', `[回复] ${decision.text}`)
          // Phase 3: pre-action humanizer delay (no jitter for a text send).
          await this.policy?.beforeAction({ type: 'reply', text: decision.text })
          let success = false
          let actionErr: Error | undefined
          try {
            await this.device.sendMessage(decision.text)
            success = true
          } catch (sendErr) {
            actionErr = sendErr instanceof Error ? sendErr : new Error(String(sendErr))
            throw actionErr
          } finally {
            await this.policy?.afterAction(
              { type: 'reply', text: decision.text },
              { success, err: actionErr }
            )
          }
          this.hooks.onActionComplete?.({ type: 'text', content: decision.text } as ActionItem, {
            success: true
          })
          break
        }
        case 'skip':
          this.emitLog('skip', decision.reason ? `跳过：${decision.reason}` : '跳过回复')
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

  /**
   * Sleep that wakes early when `this.running` flips to false. Used by the
   * Phase-3 policy gate so a long schedule-out-of-window wait can be
   * interrupted promptly when the user clicks stop.
   */
  private async cancellableSleep(ms: number): Promise<void> {
    const slice = 500
    const start = Date.now()
    while (this.running && Date.now() - start < ms) {
      const remaining = ms - (Date.now() - start)
      await this.sleep(Math.min(slice, Math.max(0, remaining)))
    }
  }
}
