import { screen } from 'electron'
import activeWin from 'active-win'
import { AppType } from './types'
import { captureWechatWindow } from './screenshot-utils'

const IS_WINDOWS = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

interface WindowBounds {
  x?: number
  y?: number
  width?: number
  height?: number
}

interface ValidatedBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Minimal shape we read off `active-win`'s `Result`. Real type is a giant union
 * across macOS/Windows/Linux variants; we only touch `title` and `owner.name`.
 */
interface ActiveWindowInfo {
  title?: string
  owner?: { name?: string }
}

/**
 * Minimal shape we use from `node-window-manager`'s `Window`.
 */
interface NodeWindow {
  getTitle(): string
  isVisible(): boolean
  getBounds?: () => WindowBounds
  bounds?: WindowBounds
}

interface NodeWindowManager {
  getActiveWindow(): NodeWindow | null
  getWindows(): NodeWindow[]
}

/**
 * Cross-platform window-handle abstraction. `getBounds()` is mac/Windows
 * (node-window-manager); `bounds` field is the active-win shape (mac).
 */
type PlatformWindow = ActiveWindowInfo & NodeWindow

async function getOpenWindowsSafe(): Promise<ActiveWindowInfo[]> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('active-win getOpenWindows timeout')), 5000)
    })

    // 如果系统没有给权限，activeWin在某些版本可能卡死，强制5秒超时
    const windows = await Promise.race([activeWin.getOpenWindows(), timeoutPromise])
    return windows as ActiveWindowInfo[]
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[window-utils] getOpenWindowsSafe error or timeout:', message)
    return []
  }
}

export function matchWechatType(name: string, appType: AppType): boolean {
  if ((appType as string) === 'whatsapp') {
    return ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp'].includes(name)
  }
  const wechatName =
    appType === 'weixin' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
  return wechatName.includes(name)
}

function getWechatWindow(
  appType: AppType,
  windows: ActiveWindowInfo[]
): ActiveWindowInfo | undefined {
  let appTargetName: string[]
  let windowTitle: string[]

  if ((appType as string) === 'whatsapp') {
    appTargetName = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
    windowTitle = ['‎WhatsApp', '‎WhatsApp.app', '‎WhatsApp.exe', 'WhatsApp']
  } else {
    appTargetName =
      appType === 'weixin' ? ['微信', '微信.app', 'WeChat'] : ['企业微信', '企业微信.app']
    windowTitle = appType === 'weixin' ? ['微信', 'Weixin'] : ['企业微信']
  }

  const allWechatWindows = windows.filter((window) =>
    window.owner?.name ? appTargetName.includes(window.owner.name) : false
  )

  if (allWechatWindows.length > 1) {
    const selected = allWechatWindows.find((window) =>
      window.title ? windowTitle.includes(window.title) : false
    )
    return selected
  }
  if (allWechatWindows.length === 1) {
    return allWechatWindows[0]
  }
  return undefined
}

async function getWechatWindowInWin(appType: AppType): Promise<PlatformWindow | null> {
  try {
    // Runtime require: node-window-manager is a native add-on; same reasoning as util.ts#getRobot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { windowManager } = require('node-window-manager') as {
      windowManager: NodeWindowManager
    }
    const activeWechatWindow = windowManager.getActiveWindow()
    if (activeWechatWindow && matchWechatType(activeWechatWindow.getTitle(), appType)) {
      return activeWechatWindow as PlatformWindow
    }
    const foundWindow = windowManager
      .getWindows()
      ?.find((window) => matchWechatType(window.getTitle(), appType) && window.isVisible())
    return (foundWindow as PlatformWindow | undefined) ?? null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[window-utils] getWechatWindowInWin error:', message)
    return null
  }
}

async function getWechatWindowInMac(appType: AppType): Promise<PlatformWindow | null> {
  const windows = await getOpenWindowsSafe()
  if (!windows || windows.length === 0) {
    return null
  }
  return (getWechatWindow(appType, windows) as PlatformWindow | undefined) ?? null
}

function getWindowBounds(window: PlatformWindow): WindowBounds | null {
  if (typeof window.getBounds === 'function') {
    return window.getBounds()
  }
  if (window.bounds) {
    return window.bounds
  }
  return null
}

function validateWindowBounds(bounds: WindowBounds | null): bounds is ValidatedBounds {
  if (!bounds) return false
  if (
    bounds.x === undefined ||
    bounds.y === undefined ||
    !bounds.width ||
    !bounds.height ||
    (bounds.width && bounds.width < 100) ||
    (bounds.height && bounds.height < 100)
  ) {
    return false
  }
  const isVisible = bounds.width > 0 && bounds.height > 0
  return isVisible
}

interface WechatWindowInfoResult {
  wechatWindow: PlatformWindow
  bounds: ValidatedBounds
  wechatType: AppType
  display: {
    id: number
    scaleFactor: number
    bounds: { x: number; y: number; width: number; height: number }
  }
}

interface WechatWindowInfoCache {
  result: WechatWindowInfoResult | null
  timestamp: number
}

const WINDOW_INFO_CACHE_DURATION = 5000 // 5 seconds cache
const wechatWindowInfoCache = new Map<AppType, WechatWindowInfoCache>()
const wechatWindowInfoPendingPromises = new Map<AppType, Promise<WechatWindowInfoResult | null>>()

export async function getWechatWindowInfo(
  appType: AppType
): Promise<WechatWindowInfoResult | null> {
  const cached = wechatWindowInfoCache.get(appType)
  const now = Date.now()
  if (cached && now - cached.timestamp < WINDOW_INFO_CACHE_DURATION) {
    return cached.result
  }

  const pendingPromise = wechatWindowInfoPendingPromises.get(appType)
  if (pendingPromise) return pendingPromise

  const queryPromise = (async (): Promise<WechatWindowInfoResult | null> => {
    try {
      const wechatWindow = IS_WINDOWS
        ? await getWechatWindowInWin(appType)
        : IS_MAC
          ? await getWechatWindowInMac(appType)
          : null
      if (!wechatWindow) return null

      const bounds = getWindowBounds(wechatWindow)
      if (!validateWindowBounds(bounds)) return null

      const display = screen.getDisplayMatching({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      })

      const result: WechatWindowInfoResult = {
        wechatWindow,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        wechatType: appType,
        display: { id: display.id, scaleFactor: display.scaleFactor, bounds: display.bounds }
      }
      wechatWindowInfoCache.set(appType, { result, timestamp: Date.now() })
      return result
    } catch (e) {
      console.error('getWechatWindowInfo error:', e)
      return null
    } finally {
      wechatWindowInfoPendingPromises.delete(appType)
    }
  })()

  wechatWindowInfoPendingPromises.set(appType, queryPromise)
  return queryPromise
}

export interface FullWindowInfo {
  wechatWindow: PlatformWindow
  bounds: ValidatedBounds
  wechatType: AppType
  scaleFactor: number
  screenshot?: string
}

export const getWindowInfo = async (
  appType: AppType = 'weixin',
  includeScreenshot: boolean = true
): Promise<FullWindowInfo | null> => {
  if (!includeScreenshot) {
    const result = await getWechatWindowInfo(appType)
    if (!result) return null
    return {
      wechatWindow: result.wechatWindow,
      bounds: result.bounds,
      wechatType: result.wechatType,
      scaleFactor: result.display.scaleFactor
    }
  }

  try {
    const windowCore = await getWechatWindowInfo(appType)
    if (!windowCore) return null

    const result = await captureWechatWindow(appType)
    if (!result.success) return null
    if (!result.screenshotBase64) return null

    return {
      wechatWindow: windowCore.wechatWindow,
      bounds: {
        x: result.bounds.x,
        y: result.bounds.y,
        width: result.bounds.width,
        height: result.bounds.height
      },
      wechatType: windowCore.wechatType,
      scaleFactor: result.display.scaleFactor,
      screenshot: result.screenshotBase64
    }
  } catch (error) {
    console.error('getWindowInfo failure:', error)
    return null
  }
}

/**
 * 同步获取窗口信息（从内存缓存读取，不发起系统调用）
 * 前提：measureLayout 时已经调过 getWindowInfo/getWechatWindowInfo，缓存有数据
 */
export function getWindowInfoSync(appType: AppType): {
  bounds: ValidatedBounds
  scaleFactor: number
} | null {
  const cached = wechatWindowInfoCache.get(appType)
  if (!cached?.result) return null

  return {
    bounds: cached.result.bounds,
    scaleFactor: cached.result.display?.scaleFactor || 1
  }
}
