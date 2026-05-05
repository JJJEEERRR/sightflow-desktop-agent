// src/core/engine.ts
// 主引擎循环 — 感知→决策→执行闭环（Scenario-agnostic）。
//
// Phase 4: 微信特定的编排（红点检测、双击激活、联系人列表轮询）从 Engine
// 抽离到 Scenario 接口背后。Engine 现在只负责:
//   1. 启动 — Lifecycle 握手 + Watchdog 协作
//   2. 测量 — 调用 scenario.measureLayout()
//   3. 截图+决策 — scenario.screenshot() → brain.decide(ctx)
//   4. 执行 — scenario.execute(decision, helpers)
//   5. 等待下一条 — scenario.waitForNextChat(running, helpers)
// 加上 OCR 采样、policy 门控、SHA-256 哈希观测等横切关注点。

import { createHash } from 'node:crypto'
import { AgentHooks, ActionItem } from './hooks'
import { getLogger, newTraceId, type Logger } from './observability'
import { Lifecycle, type LifecycleState } from './runtime'
import type { AgentBrain, BrainContext } from './brain'
import type { OcrEngine } from './ocr'
import type { AntiDetectionPolicy } from './policy'
import type { Scenario, ScenarioHelpers } from './scenarios/types'
import type { AppType } from './rpa/types'

export class Engine {
  private running = false
  private readonly log: Logger
  private readonly lifecycle: Lifecycle
  private currentTraceId: string | undefined
  private currentAppType: AppType = 'weixin'
  private lastOcrAt = 0
  private readonly nowFn: () => number

  /**
   * Phase 2 introduced `brain` (replaces the former `hooks.getReply`).
   * Phase 3 added an optional `policy` consulted before every tick and
   * around every device action. Phase 4 added the optional `ocr` engine
   * (sample-rate-limited per `policy.config.ocr.sampleIntervalMs`) and the
   * `Scenario` parameter — engine no longer holds a `DesktopDevice`
   * directly; everything app-specific (screenshot, send-reply, wait-for-
   * next-chat) goes through the scenario. `nowFn` is injectable so tests
   * can drive sample-interval boundaries deterministically.
   */
  constructor(
    private brain: AgentBrain,
    private scenario: Scenario,
    private hooks: AgentHooks = {},
    private onLog?: (type: string, content: string) => void,
    lifecycle?: Lifecycle,
    private policy?: AntiDetectionPolicy,
    private ocr?: OcrEngine,
    nowFn: () => number = (): number => Date.now()
  ) {
    this.lifecycle = lifecycle ?? new Lifecycle()
    this.log = getLogger('engine')
    this.nowFn = nowFn
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

  /**
   * Build the helpers struct passed to every scenario call. A fresh struct
   * per call keeps the surface immutable from the scenario's POV; the
   * underlying engine state (policy, hooks, log routing) is shared by
   * reference.
   */
  private scenarioHelpers(contactId?: string): ScenarioHelpers {
    return {
      emitLog: (type, content) => this.emitLog(type, content),
      sleep: (ms) => this.sleep(ms),
      policy: this.policy,
      hooks: this.hooks,
      contactId
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
      const measureResult = await this.scenario.measureLayout()

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

          await this.scenario.waitForNextChat(() => this.running, this.scenarioHelpers())
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
    this.scenario.clearChatBaseline()
    // Best-effort OCR teardown. Promise is intentionally not awaited (stop()
    // is sync to keep IPC responses snappy) but is contractually idempotent
    // and no-throw, so leaking it is safe.
    void this.ocr?.dispose().catch((err) => {
      this.log.warn('OCR dispose failed', { err })
    })
    // Best-effort scenario teardown. Same reasoning as OCR — fire-and-
    // forget; defensive `?.` because `dispose` is an optional method on
    // the Scenario interface.
    if (this.scenario.dispose) {
      void this.scenario.dispose().catch((err) => {
        this.log.warn('scenario dispose failed', { err })
      })
    }
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Allow external orchestrators (e.g. the main-process IPC handlers) to update
   * the engine's target application type without reaching into private fields.
   * Engine keeps a local copy so the value can be plumbed into `BrainContext`
   * without round-tripping through the scenario, and forwards to the
   * scenario's optional `setAppType` hook so the underlying device can pick
   * up new RPA hot spots.
   */
  setAppType(appType: AppType): void {
    this.currentAppType = appType
    this.scenario.setAppType?.(appType)
  }

  // ── Step 3+4: 发图 → 回复 ──

  /**
   * 处理当前对话：截图 → brain 决策 → scenario 执行回复 → 设置 diff baseline
   *
   * Phase 4 起，"如何在这个 app 里截图 / 如何执行 reply 决策" 完全交给 Scenario，
   * Engine 只负责：
   *   - 调用 scenario.screenshot() / scenario.execute() / scenario.setChatBaseline()
   *   - 把上下文打包成 BrainContext 喂给 brain
   *   - 把 brain 流式输出的 thinking/decision 路由到 emitLog / scenario
   *   - 横切关注点：policy 门控、screenshot hash 观测、OCR 采样
   */
  private async processCurrentChat(): Promise<void> {
    // Take the screenshot first so we can derive a per-contact identifier
    // before the policy gate runs — the rate-limiter's per-contact cap
    // needs to know which contact this tick is for. The screenshot itself
    // is cheap (already cached upstream) and gating after it lets the
    // breaker's screenshotHash freeze-detection signal still fire on
    // every tick that passes the gate.
    const screenshot = await this.scenario.screenshot()
    this.emitLog('thinking', '截图完成，请求 AI 分析...')

    // Per-contact rate-limit plumbing. Derive an opaque, stable contactId so
    // the rate limiter can enforce per-contact daily caps. If the scenario
    // can't figure out who we're talking to (no implementation, or it
    // returned undefined), per-contact gates skip — global rate limits
    // still apply. See ADR-0012.
    const contactId = (await this.scenario.getContactId?.(screenshot)) ?? undefined

    // ── Phase 3: anti-detection gate ────────────────────────────────────
    if (this.policy) {
      const gate = await this.policy.beforeReply({ contactId })
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

    // Phase 3 cleanup: feed the screenshot's content hash to the breaker so its
    // freeze-detection signal actually fires. SHA-256 is exact-match (no
    // perceptual tolerance) — sufficient to catch "WeChat hung" / "login
    // dialog popped" because in those cases the captured pixels are byte-for-
    // byte identical across many seconds.
    if (this.policy) {
      const hash = createHash('sha256').update(screenshot).digest('hex')
      this.policy.observe({ type: 'screenshotHash', hash })
    }

    // OCR sampling — run only if policy enabled, OCR engine present, and the
    // configured sample interval has elapsed. Tesseract.js can be slow
    // (~200-500ms) so we never want to run it on every loop. Failures are
    // silent (the engine returns '' and we just don't observe anything this
    // cycle).
    if (this.policy && this.ocr) {
      const ocrCfg = this.policy.getConfig().ocr
      if (ocrCfg.enabled) {
        const now = this.nowFn()
        if (now - this.lastOcrAt >= ocrCfg.sampleIntervalMs) {
          this.lastOcrAt = now
          try {
            const buffer = screenshotToBuffer(screenshot)
            const text = await this.ocr.extract(buffer)
            if (text.length > 0) {
              this.policy.observe({ type: 'screenText', text })
            }
          } catch (err) {
            // Defensive — `extract()` is contractually no-throw, but a buggy
            // implementation shouldn't take the loop down.
            this.log.warn('OCR extract threw', { err })
          }
        }
      }
    }

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
          await this.scenario.execute(stream.decision, this.scenarioHelpers(contactId))
        }
      }
      if (sawDecision) this.policy?.observe({ type: 'aiSuccess' })
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.policy?.observe({ type: 'aiFailure', err: e })
      throw e
    }

    if (this.running) {
      await this.scenario.setChatBaseline()
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

/**
 * Convert the device's screenshot string (a `data:image/png;base64,...`
 * data URL produced by RPADevice) into a Buffer suitable for the
 * OcrEngine's `extract()` contract. We strip the data-URL prefix when
 * present; otherwise the input is treated as a raw base64 payload.
 *
 * Exported indirectly only via test fakes — the conversion lives in the
 * engine because the OCR boundary itself is intentionally Buffer-typed
 * (decouples the OCR plug-in from however the device happens to encode
 * the screenshot).
 */
function screenshotToBuffer(screenshot: string): Buffer {
  const comma = screenshot.indexOf(',')
  const payload =
    comma >= 0 && screenshot.startsWith('data:') ? screenshot.slice(comma + 1) : screenshot
  return Buffer.from(payload, 'base64')
}
