import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  powerSaveBlocker,
  safeStorage
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { checkAndRequestPermissions } from './permission'
import Store from 'electron-store'
import {
  SecureStore,
  buildSettingsForRenderer,
  readSettingForRenderer,
  WRITABLE_SETTING_KEYS,
  type KvStore
} from './secure-store'
import { Engine } from '../core/engine'
import { LocalHooks } from '../core/local-hooks'
import { RPADevice } from '../core/rpa-device'
import { VlmBrain, OpenAICompatProvider, type AgentBrain, type BrainConfig } from '../core/brain'
import type { AppType } from '../core/rpa/types'
import {
  configureLogger,
  ConsoleSink,
  RingBufferSink,
  JsonFileSink,
  getLogger,
  type LogRecord
} from '../core/observability'
import { Lifecycle, Watchdog } from '../core/runtime'
import type { LifecycleEvent, LifecycleSnapshot } from '../core/runtime'
import {
  AntiDetectionPolicy,
  defaultAntiDetectionConfig,
  parseAntiDetectionConfig,
  type AntiDetectionConfig,
  type KvStorage
} from '../core/policy'

// `electron-store` ships both CJS and ESM bundles; in some bundlers the import
// arrives as `{ default: Store }`, in others as `Store` directly. This handles
// both shapes without resorting to `any`.
const StoreClass =
  typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default
const settingsStore = new StoreClass({
  name: 'settings',
  defaults: { apiKey: '', model: '', baseURL: '', systemPrompt: '', locale: 'zh' }
})

// Separate store for runtime policy state (rate-limiter counters, etc.). Kept
// distinct from `settings` so user-edited config and engine-managed state
// don't conflict, and so a settings reset won't blow away rate-limiter
// history (a real risk if the user just wanted to change the API key).
const policyStateStore = new StoreClass({
  name: 'policy-state',
  defaults: {}
})

const policyKvStorage: KvStorage = {
  get<T>(key: string): T | undefined {
    return policyStateStore.get(key) as T | undefined
  },
  set(key: string, value: unknown): void {
    policyStateStore.set(key, value)
  }
}

interface EngineStartConfig {
  apiKey: string
  model?: string
  baseURL?: string
  systemPrompt?: string
  appType?: AppType
}

let engine: Engine | null = null
let currentBrain: AgentBrain | null = null
let powerSaveBlockerId: number | null = null
let unsubscribeLifecycle: (() => void) | null = null
// One Lifecycle + one Watchdog per engine:start session. Held at module scope
// so the Watchdog's restart closure can replace `engine` in place when the
// agent loop crashes and is rebuilt.
let sharedLifecycle: Lifecycle | null = null
let watchdog: Watchdog | null = null
// Anti-detection policy is also one-per-session and survives engine rebuilds
// (rate-limiter counters, breaker state must NOT reset across watchdog
// restarts — that's the whole point of the breaker).
let currentPolicy: AntiDetectionPolicy | null = null

// SecureStore wraps `settingsStore` for at-rest encryption of the API key via
// Electron's `safeStorage`. Constructed inside `app.whenReady()` because
// `safeStorage` requires app initialization on Linux/macOS. Held at module
// scope so all IPC handlers share the same instance (and the same one-time
// "encryption unavailable" warning state).
let secureStore: SecureStore | null = null

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
// We log these and let the process keep running. The Watchdog handles
// in-process recovery for the engine loop; these handlers exist so that
// rejections leaking out of any other surface (settings, IPC handlers,
// etc.) don't take the whole main process down silently.
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

  // ── SecureStore boot (must precede any settings:* handler that reads/writes apiKey) ──
  // The cast goes through `unknown` because electron-store's strict generic
  // signatures don't unify with our minimal KvStore shape, but the runtime
  // contract (get / set / delete) is identical.
  const settingsKv = settingsStore as unknown as KvStore
  secureStore = new SecureStore({
    store: settingsKv,
    safeStorage,
    onFallback: (reason) => log.warn('secure-store fallback', { reason })
  })
  // Transparently migrate any plaintext apiKey left over from previous
  // versions. Idempotent — safe to run on every boot. The success info log
  // is emitted from inside the wrapper so we don't double-log here.
  secureStore.migrateLegacyApiKey()
  const ss = secureStore

  // ── Settings 持久化 ──
  // Both read handlers are thin wrappers around pure helpers in
  // `secure-store.ts` — see that module for the apiKey/apiKeyEncrypted
  // routing rules. Routing logic is unit-tested without booting IPC.
  ipcMain.handle('settings:getAll', async () => {
    return buildSettingsForRenderer(settingsStore.store as Record<string, unknown>, ss)
  })

  ipcMain.handle('settings:get', async (_event, key: string) => {
    return readSettingForRenderer(key, ss, settingsKv)
  })

  ipcMain.handle('settings:set', async (_event, data: Record<string, unknown>) => {
    if ('apiKey' in data) {
      const ak = data.apiKey
      if (typeof ak === 'string') {
        ss.setApiKey(ak)
      } else if (ak === null || ak === undefined) {
        ss.clearApiKey()
      } else {
        // A non-string apiKey from the renderer is almost certainly a bug.
        // Drop it and warn rather than persisting `String(value)` garbage.
        log.warn('settings:set rejected non-string apiKey', { type: typeof ak })
      }
    }
    // Explicit allowlist (preferred over a rest-destructure / blocklist) so
    // adding a new public setting is a deliberate action, not an accidental
    // pass-through. `apiKey` and `apiKeyEncrypted` are deliberately excluded;
    // the secure store is the only writer for those.
    for (const k of WRITABLE_SETTING_KEYS) {
      if (k in data) settingsStore.set(k, data[k])
    }
    return { success: true }
  })

  // ── Engine 操控 ──
  ipcMain.handle('engine:start', async (_event, config: EngineStartConfig) => {
    if (engine?.isRunning()) return { success: false, error: '引擎已在运行中' }
    try {
      // Phase 2: brain owns the decision pipeline; provider wraps the LLM.
      const provider = new OpenAICompatProvider({
        apiKey: config.apiKey,
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {})
      })
      currentBrain = new VlmBrain({
        provider,
        ...(config.systemPrompt !== undefined && config.systemPrompt.length > 0
          ? { systemPrompt: config.systemPrompt }
          : {})
      })

      // Brand-new Lifecycle for this session. The Watchdog needs a single
      // Lifecycle that persists across engine reconstructions so the restart
      // budget accumulates correctly.
      sharedLifecycle = new Lifecycle()

      // Build the anti-detection policy from persisted settings. parseAntiDetectionConfig
      // tolerates undefined / partial input by falling back to defaults; if the
      // user has never opened the settings page yet the resulting config is
      // entirely default. The policy survives engine rebuilds (see comment on
      // `currentPolicy`).
      const persistedAd = settingsStore.get('antiDetection') as unknown
      let parsedAd: AntiDetectionConfig
      try {
        parsedAd = parseAntiDetectionConfig(persistedAd ?? {})
      } catch (err) {
        log.warn('Persisted antiDetection config invalid; falling back to defaults', { err })
        parsedAd = defaultAntiDetectionConfig()
      }
      currentPolicy = new AntiDetectionPolicy({
        config: parsedAd,
        storage: policyKvStorage
      })

      const mainWindow = BrowserWindow.getAllWindows()[0]
      const onLog = (type: string, content: string): void => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('engine:log', { type, content })
        }
      }

      // buildEngine recreates Engine + RPADevice + LocalHooks but reuses the
      // existing brain and shared lifecycle. Used both for the initial start
      // and by the Watchdog for restarts.
      const buildEngine = (): Engine => {
        const localHooks = new LocalHooks()
        const device = new RPADevice()
        device.setAppType(config.appType || 'weixin')
        device.setApiKey(config.apiKey)
        const e = new Engine(
          currentBrain!,
          device,
          localHooks,
          onLog,
          sharedLifecycle!,
          currentPolicy ?? undefined
        )
        e.setAppType(config.appType || 'weixin')
        return e
      }

      engine = buildEngine()

      // Subscribe to lifecycle transitions: forward to renderer over a
      // dedicated channel, and gate the powerSaveBlocker on the running state.
      unsubscribeLifecycle?.()
      unsubscribeLifecycle = sharedLifecycle.subscribe((event: LifecycleEvent) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) {
          win.webContents.send('engine:state', {
            event,
            snapshot: sharedLifecycle?.snapshot()
          })
        }

        if (event.to === 'running') {
          if (powerSaveBlockerId === null) {
            powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
            log.info('powerSaveBlocker started', { id: powerSaveBlockerId })
          }
        } else if (event.to === 'stopped') {
          if (powerSaveBlockerId !== null) {
            powerSaveBlocker.stop(powerSaveBlockerId)
            log.info('powerSaveBlocker stopped', { id: powerSaveBlockerId })
            powerSaveBlockerId = null
          }
        } else if (event.to === 'crashed') {
          // While we hold the blocker through transient crashes (so the
          // Watchdog can recover before the OS suspends us), we MUST release
          // it once the Watchdog gives up — otherwise a flapping engine
          // would leak the blocker indefinitely. Defer the check by a tick
          // so the Watchdog has had a chance to run its post-crash
          // accounting on this same event.
          setImmediate(() => {
            if (
              watchdog?.getStats().givenUp &&
              sharedLifecycle?.getState() === 'crashed' &&
              powerSaveBlockerId !== null
            ) {
              powerSaveBlocker.stop(powerSaveBlockerId)
              log.info('powerSaveBlocker stopped (watchdog gave up)', {
                id: powerSaveBlockerId
              })
              powerSaveBlockerId = null
            }
          })
        }
      })

      // Watchdog: monitors the shared lifecycle, rebuilds engine on crash.
      watchdog?.stop()
      watchdog = new Watchdog({
        lifecycle: sharedLifecycle,
        restart: async (): Promise<void> => {
          log.info('Watchdog restart() invoked; rebuilding engine')
          // Tear down the previous engine instance fully. `engine.stop()`
          // is a no-op on the FSM if state isn't running/paused/crashed
          // (and at this point we are in `recovering`), so this only flips
          // the internal `running` boolean.
          engine?.stop()
          engine = buildEngine()
          // Kick off the loop. The engine itself transitions
          // recovering → running once measureLayout succeeds.
          engine.start().catch((err) => {
            log.error('Engine loop error after restart', { err })
          })
        }
      })
      watchdog.start()

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
    // Stop the watchdog first so a graceful shutdown is not interpreted as
    // a crash to recover from.
    watchdog?.stop()
    watchdog = null
    engine.stop()
    // Release the powerSaveBlocker explicitly here too. The lifecycle
    // listener also does this on the `stopped` event, but stop() races with
    // the loop tail and the listener firing — calling it idempotently is
    // safe and guarantees the blocker is gone before the IPC reply.
    if (powerSaveBlockerId !== null) {
      powerSaveBlocker.stop(powerSaveBlockerId)
      powerSaveBlockerId = null
    }
    return { success: true }
  })

  ipcMain.handle('engine:status', async () => {
    return { running: engine?.isRunning() ?? false }
  })

  // ── Anti-detection policy IPC ────────────────────────────────────────────
  // Renderer fetches the current config (or default if unset) and pushes
  // patches. All input is zod-validated; an invalid patch returns an error
  // instead of corrupting persisted state. snapshot exposes counters/state
  // for the future settings + diagnostics surfaces.

  ipcMain.handle('policy:get', async (): Promise<AntiDetectionConfig> => {
    if (currentPolicy) return currentPolicy.getConfig()
    const persisted = settingsStore.get('antiDetection') as unknown
    try {
      return parseAntiDetectionConfig(persisted ?? {})
    } catch {
      return defaultAntiDetectionConfig()
    }
  })

  ipcMain.handle(
    'policy:set',
    async (
      _event,
      patch: unknown
    ): Promise<
      { success: true; config: AntiDetectionConfig } | { success: false; error: string }
    > => {
      try {
        // Merge against the current effective config so callers can send
        // partial patches (e.g. only humanizer fields) without nuking the rest.
        const current =
          currentPolicy?.getConfig() ??
          parseAntiDetectionConfig((settingsStore.get('antiDetection') as unknown) ?? {})
        const merged = parseAntiDetectionConfig({
          ...current,
          ...((patch ?? {}) as Partial<AntiDetectionConfig>)
        })
        settingsStore.set('antiDetection', merged)
        currentPolicy?.updateConfig(merged)
        log.info('policy config updated', {})
        return { success: true, config: merged }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('policy:set rejected', { err: message })
        return { success: false, error: message }
      }
    }
  )

  ipcMain.handle('policy:snapshot', async () => {
    return currentPolicy?.snapshot() ?? null
  })

  // Used by the future "user resumes from circuit-break pause" flow. Idempotent.
  ipcMain.handle('policy:resetBreaker', async () => {
    currentPolicy?.resetBreaker()
    return { success: true }
  })

  // Returns the latest lifecycle snapshot. Renderer can poll this on connect
  // to reconcile its UI before the next 'engine:state' event arrives. Reads
  // from the shared Lifecycle (not engine.getLifecycle()) so the value
  // persists across Watchdog-driven engine reconstructions.
  ipcMain.handle('engine:lifecycle', async (): Promise<LifecycleSnapshot | null> => {
    return sharedLifecycle?.snapshot() ?? null
  })

  // Returns the most recent N log records. Used by the future Diagnostics tab
  // and is already useful for ad-hoc debugging via DevTools.
  ipcMain.handle('logs:recent', async (_event, limit: number = 200): Promise<LogRecord[]> => {
    const all = logRingBuffer.getAll()
    return all.slice(-Math.min(Math.max(limit, 1), 2000))
  })

  ipcMain.handle(
    'engine:updateConfig',
    async (_event, config: Partial<BrainConfig> & { appType?: AppType }) => {
      if (currentBrain) {
        currentBrain.updateConfig(config)
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
    async (_event, config: Partial<BrainConfig> & { apiKey: string }) => {
      // Build a temporary provider so the user can validate credentials
      // before the engine ever spins up. We don't reuse `currentBrain`
      // because it may not exist yet (first run / settings page).
      const provider = new OpenAICompatProvider({
        apiKey: config.apiKey,
        ...(config.model !== undefined ? { model: config.model } : {}),
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {})
      })
      return provider.testConnection()
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
    const apiKey = secureStore?.getApiKey() ?? ''
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
