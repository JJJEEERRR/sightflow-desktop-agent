// src/core/rpa-device.ts
// RPADevice — DesktopDevice 的真实 RPA 实现
//
// 串联 screenshot-utils、input-utils、has-unread、vision-utils
// 所有感知和动作能力在这里汇聚

import { DesktopDevice } from './device'
import { AIClient } from './ai-client'
import { AppType } from './rpa/types'
import { BBox } from './rpa/vision-utils'
import { takeWeChatScreenshot } from './rpa/screenshot-utils'
import {
  sendReplyAction,
  activeUnreadByClickAction,
  clickUnreadContactAction
} from './rpa/input-utils'
import {
  hasUnreadMessage as hasUnreadMessageDetect,
  isChatContactUnread as isChatContactUnreadDetect
} from './rpa/has-unread'
import {
  setChatBaseline as setChatBaselineFn,
  checkChatAreaDiff,
  clearChatBaseline as clearChatBaselineFn
} from './rpa/image-compare'
import {
  detectUnreadArea as detectUnreadAreaFn,
  detectWechatLayout,
  getInputAreaFromCache,
  getLayoutCache,
  setLayoutCache
} from './rpa/vision-utils'
import { getWechatWindowInfo } from './rpa/window-utils'
import { getLogger } from './observability'

const log = getLogger('rpa-device')

export class RPADevice implements DesktopDevice {
  private appType: AppType = 'weixin'
  private aiClient: AIClient | null = null

  setAppType(appType: AppType): void {
    this.appType = appType
  }

  setApiKey(apiKey: string): void {
    if (!apiKey) return
    this.aiClient = new AIClient({ apiKey })
  }

  // ── 感知层 ──

  /**
   * 启动时一次性 VLM 布局测量（并行执行）
   *
   * 并行调两个 VLM 检测任务:
   * 1. detectUnreadArea — chatEntranceArea + firstContact（红点检测用）
   * 2. detectWechatLayout — searchInputBox + headerArea + chatMainArea（diff/搜索用）
   *
   * 检测完成后，从 chatMainArea 反推 inputArea（纯计算，无外部调用）
   */
  async measureLayout(): Promise<{ success: boolean; error?: string }> {
    if (!this.aiClient) {
      log.error('measureLayout aborted: aiClient not initialized')
      return { success: false, error: 'AI Client 未初始化' }
    }

    try {
      const windowInfo = await getWechatWindowInfo(this.appType)
      if (!windowInfo) {
        const appName =
          this.appType === 'weixin' ? '微信' : this.appType === 'wework' ? '企业微信' : 'WhatsApp'
        return { success: false, error: `未找到${appName}窗口，请确保已打开且未被完全遮挡/最小化` }
      }

      log.info('measureLayout start (parallel VLM)')

      const [unreadResult, layoutResult] = await Promise.allSettled([
        detectUnreadAreaFn(this.aiClient, this.appType),
        detectWechatLayout(this.aiClient, this.appType)
      ])

      const unreadOk = unreadResult.status === 'fulfilled' && unreadResult.value.success
      const layoutOk = layoutResult.status === 'fulfilled' && layoutResult.value.success

      log.info('VLM detection results', {
        detectUnreadArea: unreadOk,
        detectWechatLayout: layoutOk
      })

      if (unreadResult.status === 'fulfilled' && unreadResult.value.success) {
        log.debug('unread area detected', {
          chatEntrance: unreadResult.value.chatEntranceArea?.coordinates,
          firstContact: unreadResult.value.firstContact?.coordinates
        })
      } else {
        const error =
          unreadResult.status === 'rejected'
            ? unreadResult.reason
            : unreadResult.value.success === false
              ? unreadResult.value.error
              : undefined
        log.error('unread area detection failed', { err: error })
      }

      if (layoutResult.status === 'fulfilled' && layoutResult.value.success) {
        log.debug('main layout detected', {
          searchInputBox: layoutResult.value.searchInputBox?.coordinates,
          headerArea: layoutResult.value.headerArea?.coordinates,
          chatMainArea: layoutResult.value.chatMainArea?.coordinates
        })

        const inputArea = getInputAreaFromCache(this.appType)
        if (inputArea) {
          log.debug('input area (derived from chatMainArea)', {
            coordinates: inputArea.coordinates
          })
        } else {
          log.warn('input-area derivation from cache failed')
        }
      } else {
        const error =
          layoutResult.status === 'rejected'
            ? layoutResult.reason
            : layoutResult.value.success === false
              ? layoutResult.value.error
              : undefined
        log.warn('main layout detection failed (non-fatal)', { err: error })
      }

      if (!unreadOk) {
        log.error('measureLayout failed: unread area is mandatory')
        const errorMsg =
          unreadResult.status === 'fulfilled' && !unreadResult.value.success
            ? unreadResult.value.error || '未读区域检测是必要条件'
            : '未读区域检测是必要条件'
        return { success: false, error: `布局测量失败: ${errorMsg}` }
      }

      log.info('measureLayout done')
      return { success: true }
    } catch (error) {
      log.error('measureLayout exception', { err: error })
      return { success: false, error: String(error) }
    }
  }

  async screenshot(): Promise<string> {
    const result = await takeWeChatScreenshot({ wechatType: this.appType })
    if (!result.success) {
      throw new Error(result.error || '截图失败')
    }
    if (!result.screenshot) {
      throw new Error('截图失败')
    }
    return result.screenshot
  }

  async hasUnreadMessage(): Promise<{
    hasUnread: boolean
    chatEntranceArea?: { bbox: BBox; coordinates: [number, number] }
  }> {
    if (!this.aiClient) {
      log.warn('hasUnreadMessage: aiClient not initialized')
      return { hasUnread: false }
    }

    const result = await hasUnreadMessageDetect(this.aiClient, this.appType)

    if (!result.success) {
      log.error('hasUnreadMessage failed', { err: result.error })
      return { hasUnread: false }
    }

    return {
      hasUnread: result.hasUnread || false,
      chatEntranceArea: result.chatEntranceArea
    }
  }

  async isChatContactUnread(): Promise<{
    isUnread: boolean
    firstContactCoords?: [number, number]
  }> {
    if (!this.aiClient) {
      log.warn('isChatContactUnread: aiClient not initialized')
      return { isUnread: false }
    }

    const result = await isChatContactUnreadDetect(this.aiClient, this.appType)

    if (!result.success) {
      log.error('isChatContactUnread failed', { err: result.error })
      return { isUnread: false }
    }

    return {
      isUnread: result.isUnread || false,
      firstContactCoords: result.firstContact?.coordinates
    }
  }

  /**
   * 清除未读区域的 VLM 坐标缓存（chatEntranceArea + firstContact）
   * 连续检测失败时调用：强制下次 isChatContactUnread / hasUnreadMessage 重新 VLM 定位
   */
  clearUnreadCache(): void {
    const cache = getLayoutCache(this.appType)
    if (cache) {
      cache.chatEntranceArea = null
      cache.firstContact = null
      setLayoutCache(this.appType, cache)
      log.info('cleared unread-area cache')
    }
  }

  // ── chatMainArea Diff 检测 ──

  async setChatBaseline(): Promise<boolean> {
    return setChatBaselineFn(this.appType)
  }

  async hasChatAreaChanged(): Promise<{ hasDiff: boolean; hasBaseline: boolean }> {
    return checkChatAreaDiff(this.appType)
  }

  clearChatBaseline(): void {
    clearChatBaselineFn()
  }

  // ── 动作层 ──

  async sendMessage(text: string): Promise<void> {
    const success = await sendReplyAction(this.appType, text)
    if (!success) {
      throw new Error('发送消息失败')
    }
  }

  /**
   * 点击红点区域激活未读消息（视觉路线）
   * 微信场景双击，企业微信场景单击
   */
  async activeUnreadByClick(coordinates: [number, number]): Promise<void> {
    await activeUnreadByClickAction(coordinates, this.appType)
  }

  /**
   * 点击联系人列表中的第一个联系人
   */
  async clickUnreadContact(coordinates: [number, number]): Promise<void> {
    await clickUnreadContactAction(coordinates)
  }

  async clickAt(x: number, y: number): Promise<void> {
    await clickUnreadContactAction([x, y])
  }
}
