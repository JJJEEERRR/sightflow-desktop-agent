// src/core/scenarios/wechat/scenario.ts
// WechatScenario — the WeChat / 企业微信 implementation of `Scenario`.
//
// Lifts the WeChat-specific orchestration that previously lived inside
// `Engine`:
//   - red-dot detection (粗 + 细) and the "click red dot → click contact"
//     handshake
//   - chatMainArea diff polling (the "current chat got a new message" lane)
//   - the consecutive-failure → clearUnreadCache fallback
//   - executing a `reply` brain decision against the device
//
// Engine now keeps only the brain / policy / OCR / lifecycle wiring. See
// ADR-0011.

import type { Scenario, ScenarioHelpers } from '../types'
import type { BrainDecision } from '../../brain'
import type { DesktopDevice } from '../../device'
import type { ActionItem } from '../../hooks'
import type { AppType } from '../../rpa/types'
export class WechatScenario implements Scenario {
  /**
   * Tracks how many times in a row the contact-level red-dot detection
   * came back negative right after we clicked the chatEntrance area. After
   * 3 consecutive misses we assume the cached VLM coordinates have
   * drifted and force a full re-detection.
   */
  private consecutiveUnreadFailures = 0

  constructor(private readonly device: DesktopDevice) {}

  setAppType(appType: AppType): void {
    this.device.setAppType(appType)
  }

  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    return this.device.measureLayout()
  }

  async screenshot(): Promise<string> {
    return this.device.screenshot()
  }

  async setChatBaseline(): Promise<void> {
    await this.device.setChatBaseline()
  }

  clearChatBaseline(): void {
    this.device.clearChatBaseline()
  }

  // ── 执行 brain 决策 ────────────────────────────────────────────────────

  async execute(decision: BrainDecision, helpers: ScenarioHelpers): Promise<void> {
    try {
      switch (decision.type) {
        case 'reply': {
          helpers.emitLog('reply', `[回复] ${decision.text}`)
          // Phase 3: pre-action humanizer delay (no jitter for a text send).
          await helpers.policy?.beforeAction({ type: 'reply', text: decision.text })
          let success = false
          let actionErr: Error | undefined
          try {
            await this.device.sendMessage(decision.text)
            success = true
          } catch (sendErr) {
            actionErr = sendErr instanceof Error ? sendErr : new Error(String(sendErr))
            throw actionErr
          } finally {
            await helpers.policy?.afterAction(
              { type: 'reply', text: decision.text },
              { success, err: actionErr }
            )
          }
          helpers.hooks.onActionComplete?.({ type: 'text', content: decision.text } as ActionItem, {
            success: true
          })
          break
        }
        case 'skip':
          helpers.emitLog('skip', decision.reason ? `跳过：${decision.reason}` : '跳过回复')
          break
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      helpers.emitLog('error', `执行动作失败: ${err.message}`)
      helpers.hooks.onError?.(err, 'execute_action')
    }
  }

  // ── 双通道检测（红点 + chatMainArea diff） ───────────────────────────

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
   */
  async waitForNextChat(running: () => boolean, helpers: ScenarioHelpers): Promise<void> {
    while (running()) {
      // 轮询间隔 3-5 秒
      await helpers.sleep(3000 + Math.random() * 2000)

      if (!running()) break

      // ── 通道 2: chatMainArea diff 检测 ──
      const diffResult = await this.device.hasChatAreaChanged()

      if (diffResult.hasDiff) {
        helpers.emitLog('thinking', '检测到当前对话有新消息（chatMainArea diff）')
        return
      }

      // ── 通道 1: 粗检测红点 ──
      const unreadResult = await this.device.hasUnreadMessage()

      if (!unreadResult.hasUnread) {
        continue
      }

      // ── Step 2: 点击红点区域激活未读列表 ──
      const redDotCoordinates = unreadResult.chatEntranceArea?.coordinates
      if (!redDotCoordinates) {
        helpers.emitLog('error', '检测到未读但未获取到 chatEntranceArea 坐标，继续轮询')
        continue
      }

      helpers.emitLog(
        'thinking',
        `检测到未读消息，点击红点区域 (${redDotCoordinates[0]}, ${redDotCoordinates[1]})`
      )
      await this.policyClick(
        { type: 'click', coords: redDotCoordinates },
        () => this.device.activeUnreadByClick(redDotCoordinates),
        150,
        100,
        helpers
      )

      // ── Step 3: 细检测联系人红点 ──
      let contactResult = await this.device.isChatContactUnread()

      // ── Step 3.1: 首次细检测失败 → 重新粗检测 + 再次点击 ──
      if (!contactResult.isUnread) {
        helpers.emitLog('thinking', '当前联系人无未读消息，重新检测...')
        await helpers.sleep(1000)

        const recheckResult = await this.device.hasUnreadMessage()

        if (recheckResult.hasUnread) {
          helpers.emitLog('thinking', '仍有未读消息，再次点击红点')

          const recheckCoords = recheckResult.chatEntranceArea?.coordinates
          if (recheckCoords) {
            await this.device.activeUnreadByClick(recheckCoords)
            await helpers.sleep(500)

            contactResult = await this.device.isChatContactUnread()
          }
        } else {
          helpers.emitLog('skip', '重新检测后无未读消息，继续轮询')
          continue
        }
      }

      // ── Step 3.2: 连续两次细检测失败 → 增加失败计数，达到阈值再清除缓存强制重检 ──
      if (!contactResult.isUnread) {
        this.consecutiveUnreadFailures++

        if (this.consecutiveUnreadFailures >= 3) {
          helpers.emitLog(
            'thinking',
            `连续 ${this.consecutiveUnreadFailures} 次检测失败，VLM 坐标缓存可能不准确，清除缓存强制重检`
          )
          this.device.clearUnreadCache()
          this.consecutiveUnreadFailures = 0
          await helpers.sleep(500)

          contactResult = await this.device.isChatContactUnread()

          if (!contactResult.isUnread) {
            helpers.emitLog('thinking', '缓存重建后检测失败，再点击一次')

            const retryUnread = await this.device.hasUnreadMessage()
            const retryCoords = retryUnread.chatEntranceArea?.coordinates

            if (retryCoords) {
              await this.device.activeUnreadByClick(retryCoords)
              await helpers.sleep(500)

              contactResult = await this.device.isChatContactUnread()

              if (!contactResult.isUnread) {
                helpers.emitLog('skip', '最终检测仍失败，放弃，继续轮询')
                continue
              }
            } else {
              helpers.emitLog('skip', '缓存重建后未获取到坐标，继续轮询')
              continue
            }
          }
        } else {
          helpers.emitLog(
            'skip',
            `细检测失败 (第 ${this.consecutiveUnreadFailures} 次)，暂不清除缓存，继续轮询`
          )
          continue
        }
      }

      this.consecutiveUnreadFailures = 0

      // ── Step 4: 点击未读联系人 ──
      const firstContactCoords = contactResult.firstContactCoords
      if (!firstContactCoords) {
        helpers.emitLog('skip', '未获取到 firstContact 坐标，继续轮询')
        continue
      }

      helpers.emitLog('thinking', `点击联系人 (${firstContactCoords[0]}, ${firstContactCoords[1]})`)
      await this.policyClick(
        { type: 'click', coords: firstContactCoords },
        () => this.device.clickUnreadContact(firstContactCoords),
        500,
        300,
        helpers
      )

      // 切换了联系人 → 清除旧 baseline（新对话需要新的 baseline）
      this.device.clearChatBaseline()

      return
    }
  }

  // ── 内部辅助 ──────────────────────────────────────────────────────────

  /**
   * Wraps a polling-loop click in `policy.beforeAction/afterAction` when a
   * policy is configured, otherwise falls back to the legacy ad-hoc
   * jittered sleep. Routes Humanizer pre/post delays through the click and
   * forwards the outcome (`rpaSuccess` / `rpaFailure`) into the breaker.
   * Coords are intentionally NOT reassigned from the jittered result —
   * polling clicks target VLM-derived hot spots whose stability matters
   * more than humanizer micro-jitter (those few px would push the click
   * off the red dot in some layouts).
   */
  private async policyClick(
    action: { type: 'click'; coords: [number, number] },
    perform: () => Promise<void>,
    fallbackBaseMs: number,
    fallbackJitterMs: number,
    helpers: ScenarioHelpers
  ): Promise<void> {
    const policy = helpers.policy
    if (!policy) {
      await perform()
      await helpers.sleep(fallbackBaseMs + Math.random() * fallbackJitterMs)
      return
    }
    await policy.beforeAction(action)
    let success = false
    let actionErr: Error | undefined
    try {
      await perform()
      success = true
    } catch (e) {
      actionErr = e instanceof Error ? e : new Error(String(e))
      throw actionErr
    } finally {
      await policy.afterAction(action, { success, err: actionErr })
    }
  }
}
