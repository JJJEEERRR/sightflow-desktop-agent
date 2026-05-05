import { app, shell, BrowserWindow, ipcMain, desktopCapturer, powerSaveBlocker } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import { Engine } from '../core/engine'
import { LocalHooks } from '../core/local-hooks'
import { AIClient, type AIClientConfig } from '../core/ai-client'
import { RPADevice } from '../core/rpa-device'
import type { AppType } from '../core/rpa/types'
import {
  configureLogger,
  ConsoleSink,
  RingBufferSink,
  JsonFileSink,
  getLogger,
  type LogRecord
} from '../core/observability'
import type { LifecycleEvent, LifecycleSnapshot } from '../core/runtime'

// `electron-store` ships both CJS and ESM bundles; in some bundlers the import
// arrives as `{ default: Store }`, in others as `Store` directly. This handles
// both shapes without resorting to `any`.
const StoreClass =
  typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default
const settingsStore = new StoreClass({
  name: 'settings',
  defaults: { apiKey: '', model: '', baseURL: '', systemPrompt: '', locale: 'zh' }
})

interface EngineStartConfig {
  apiKey: string
  model?: string
  baseURL?: string
  systemPrompt?: string
  appType?: AppType
}

let engine: Engine | null = null
let localHooks: LocalHooks | null = null
let powerSaveBlockerId: number | null = null
let unsubscribeLifecycle: (() => void) | null = null

// ── Observability boot ─────────────────────────────────────────────────────
// Constructed at module load so anything that runs before app.whenReady() is
// captured (logger started in 'init' state). Sinks fan out:
//   - Console (dev only): tail-friendly colored output
//   - RingBuffer: 2k records, used by ipcMain.handle('logs:recent', …)
//   - JSONL file: ~/Library/Application Support/<app>/logs/YYYY-MM-DD.jsonl
//   - RendererSink: forwards to the focused window via 'engine:log-record'
const logRingBuffer = new RingBufferSink({ size: 2000 })

const rendererSink = {
  write(record: LogRecord): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('engine:log-record', record)
    }
  }
}

const logsDir = join(app.getPath('userData'), 'logs')
const fileSink = new JsonFileSink({ dir: logsDir, dailyRotation: true, maxDays: 14 })

configureLogger({
  env: is.dev ? 'dev' : 'prod',
  sinks: [new ConsoleSink({ colorize: is.dev }), logRingBuffer, fileSink, rendererSink],
  minLevel: is.dev ? 'debug' : 'info'
})

const log = getLogger('main')

// ── Process-level safety nets ──────────────────────────────────────────────
// In Phase 1 we *log* these and let the process keep running — Phase 2 will
// add a Watchdog/auto-restart. Without this, an unhandled promise rejection
// in a deep RPA leaf would silently lose state.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { err: reason })
})
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { err })
})

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 360,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0b10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // 检查和请求 macOS 需要的权限
  await checkAndRequestPermissions()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => log.debug('pong'))

  // ── Settings 持久化 ──
  ipcMain.handle('settings:getAll', async () => {
    return settingsStore.store
  })

  ipcMain.handle('settings:get', async (_event, key: string) => {
    return settingsStore.get(key)
  })

  ipcMain.handle('settings:set', async (_event, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      settingsStore.set(key, value)
    }
    return { success: true }
  })

  // ── Engine 操控 ──
  ipcMain.handle('engine:start', async (_event, config: EngineStartConfig) => {
    if (engine?.isRunning()) return { success: false, error: '引擎已在运行中' }
    try {
      localHooks = new LocalHooks({
        ai: {
          apiKey: config.apiKey,
          model: config.model,
          baseURL: config.baseURL,
          systemPrompt: config.systemPrompt
        }
      })
      const device = new RPADevice()
      device.setAppType(config.appType || 'weixin')
      device.setApiKey(config.apiKey)
      const mainWindow = BrowserWindow.getAllWindows()[0]
      engine = new Engine(localHooks, device, (type, content) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine:log', { type, content })
        }
      })

      // Subscribe to lifecycle transitions: forward to renderer over a
      // dedicated channel, and gate the powerSaveBlocker on the running state.
      unsubscribeLifecycle?.()
      unsubscribeLifecycle = engine.getLifecycle().subscribe((event: LifecycleEvent) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send('engine:state', {
            event,
            snapshot: engine?.getLifecycle().snapshot()
          })
        }

        if (event.to === 'running') {
          if (powerSaveBlockerId === null) {
            powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
            log.info('powerSaveBlocker started', { id: powerSaveBlockerId })
          }
        } else if (event.to === 'stopped' || event.to === 'crashed') {
          if (powerSaveBlockerId !== null) {
            powerSaveBlocker.stop(powerSaveBlockerId)
            log.info('powerSaveBlocker stopped', { id: powerSaveBlockerId })
            powerSaveBlockerId = null
          }
        }
      })

      engine.start().catch((err) => {
        log.error('Engine loop error', { err })
      })

      return { success: true }
    } catch (error) {
      log.error('engine:start failed', { err: error })
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('engine:stop', async () => {
    if (!engine?.isRunning()) return { success: false, error: '引擎未运行' }
    engine.stop()
    return { success: true }
  })

  ipcMain.handle('engine:status', async () => {
    return { running: engine?.isRunning() ?? false }
  })

  // Returns the latest lifecycle snapshot. Renderer can poll this on connect
  // to reconcile its UI before the next 'engine:state' event arrives.
  ipcMain.handle('engine:lifecycle', async (): Promise<LifecycleSnapshot | null> => {
    return engine?.getLifecycle().snapshot() ?? null
  })

  // Returns the most recent N log records. Used by the future Diagnostics tab
  // and is already useful for ad-hoc debugging via DevTools.
  ipcMain.handle('logs:recent', async (_event, limit: number = 200): Promise<LogRecord[]> => {
    const all = logRingBuffer.getAll()
    return all.slice(-Math.min(Math.max(limit, 1), 2000))
  })

  ipcMain.handle(
    'engine:updateConfig',
    async (_event, config: Partial<AIClientConfig> & { appType?: AppType }) => {
      if (localHooks) {
        localHooks.updateAIConfig(config)
        if (engine && config.appType) {
          engine.setAppType(config.appType)
        }
        return { success: true }
      }
      return { success: false, error: '引擎未初始化' }
    }
  )

  ipcMain.handle(
    'engine:testConnection',
    async (_event, config: Partial<AIClientConfig> & { apiKey: string }) => {
      const client = new AIClient(config)
      return client.testConnection()
    }
  )

  ipcMain.handle('capture-screen', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (sources && sources.length > 0) {
        return sources[0].thumbnail.toDataURL()
      }
      return null
    } catch (error) {
      log.error('Screen capture failed', { err: error })
      return null
    }
  })

  // ── 测试入口：VLM 并行 vs 串行 ──
  ipcMain.handle('test:vlm-parallel', async () => {
    const apiKey = settingsStore.get('apiKey') as string
    if (!apiKey) return { error: '请先在设置中填写 API Key' }
    const { runVlmParallelTest } = await import('../core/rpa/tests/test-vlm-parallel')
    return await runVlmParallelTest(apiKey, 'weixin')
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
