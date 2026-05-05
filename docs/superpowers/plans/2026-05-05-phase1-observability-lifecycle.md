# Phase 1 — Observability + Lifecycle (Implementation Plan)

- 日期：2026-05-05
- 上游 spec：`docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md` § 6 Phase 1
- 目标：把"日志/指标/追踪"和"生命周期状态机"两套基础设施落地，
  为后续 Phase 2 (Brain) / Phase 3 (Anti-Detection) / Phase 5 (Diagnostics 面板) 提供地基

---

## 1. 范围

| 必做                                                   | 不做（留给后续 phase）                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `core/observability/{logger,metrics,trace}.ts`         | Diagnostics 面板 UI（Phase 5）                              |
| `core/runtime/lifecycle.ts` 状态机                     | 反封号 policy（Phase 3）                                    |
| 替换 `console.log` 为结构化 logger（业务不动）         | Brain 抽象（Phase 2）                                       |
| 主进程 `unhandledRejection` / `uncaughtException` 钩子 | watchdog（spec 列在 Phase 1 但下沉到 Phase 3 与熔断一起做） |
| `powerSaveBlocker`（仅 `running` 状态阻止睡眠）        | redact 函数完整化（仅做最小白名单 + apiKey 强制脱敏）       |
| IPC 新增 `engine:log-record` / `engine:state` 通道     | 渲染端消费这些通道（Phase 5）                               |
| 保留现有 `engine:log` 不破坏当前 UI                    |                                                             |

**Phase 1 完成的验收标准**：

1. `npm run build` / `npm run dev` 一切如旧（用户视角无 regression）
2. `core/` 中所有 `console.log/warn/error` 全部替换为结构化 logger
3. Engine 内部 `running/idle/...` 等隐式状态显式化为 lifecycle 状态机
4. `npm test` ≥ 100 个 test 全绿（当前 78 + 新增约 25-30）
5. 覆盖率全局 ≥ 50% lines（从当前 44.79% 提升）
6. CI 5 个 job 一次过

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Main process                             │
│   index.ts                                                  │
│     ├── configureLogger({ logsDir, env })                   │
│     ├── attachProcessHooks(logger)  ← unhandled rejection   │
│     ├── new Engine(hooks, device, logEmitter, lifecycle)    │
│     └── powerSaveBlocker subscribes to lifecycle.onChange   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌──────────────────┐
│  Logger       │   │  Lifecycle    │   │  Metrics         │
│  - 3 sinks    │   │  - FSM        │   │  - counter       │
│  - LogRecord  │   │  - Transition │   │  - histogram     │
│  - phase ctx  │   │    rules      │   │  - snapshot      │
└──────┬────────┘   └──────┬────────┘   └──────────────────┘
       │                   │
       ▼                   ▼
┌─────────────────────────────────────┐
│   Engine.tick()                     │
│   ├── logger.info({phase:'engine.tick', ...}) │
│   ├── lifecycle.transition('running' → ...)   │
│   └── metrics.counter('replies.sent_total')   │
└─────────────────────────────────────┘
```

---

## 3. Module specs

### 3.1 `core/observability/types.ts`

```ts
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string // ISO 8601
  level: LogLevel
  phase: string // 'engine.tick' | 'brain.think' | ...
  traceId?: string
  msg: string
  data?: Record<string, unknown>
  err?: { name: string; message: string; stack?: string }
}

export interface LogSink {
  write(record: LogRecord): void
  flush?(): Promise<void>
}

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, errOrData?: unknown): void
  child(phase: string, traceId?: string): Logger
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  histograms: Record<
    string,
    { count: number; sum: number; min: number; max: number; p50: number; p95: number }
  >
  takenAt: string
}

export interface TraceContext {
  traceId: string
  parentSpanId?: string
  spanId: string
  startedAt: number
}
```

### 3.2 `core/observability/logger.ts`

- `getLogger(phase)` returns a Logger bound to that phase
- `configureLogger({ env, sinks })` is called once at boot
- Built-in sinks (in `sinks/` subfolder):
  - `ConsoleSink({ colorize: boolean })` — uses `console.log/info/warn/error`
  - `RingBufferSink({ size: number })` — exposes `getAll()` for UI streaming
  - `JsonFileSink({ dir, dailyRotation: true, maxDays: 30 })` — opt-in (only main process can wire it)
- `redact(obj)` — strip keys matching `/api[_-]?key|token|secret|password/i`
- All sinks run synchronously per-record (no async fan-out → keeps log order deterministic)

### 3.3 `core/observability/metrics.ts`

- In-memory only; ~50 lines
- `counter(name, labels?)` — increments named counter; labels stringified into key
- `histogram(name, value, labels?)` — keeps last N values (default 1024) for percentile calc
- `snapshot()` — returns current state (counter sums, histogram p50/p95)
- `reset()` — for tests

### 3.4 `core/observability/trace.ts`

- `newTraceId()` — short hex (12 chars), e.g. `7a3f9c2e1b04`
- `newSpanId()` — short hex (8 chars)
- `withSpan(parent, name, fn)` — wraps async fn, generates span context, currently only used to thread `traceId` through Engine; full nested-span support is Phase 2+
- Pure utilities; no global state

### 3.5 `core/runtime/types.ts`

```ts
export type LifecycleState = 'idle' | 'running' | 'paused' | 'crashed' | 'recovering' | 'stopped'

export type PauseReason = 'user' | 'breaker' | 'permission' | 'external'

export interface LifecycleSnapshot {
  state: LifecycleState
  enteredAt: string
  pauseReason?: PauseReason
  lastError?: { name: string; message: string }
  restartBudget: { used: number; max: number; windowEndsAt: string }
}

export interface LifecycleEvent {
  from: LifecycleState
  to: LifecycleState
  at: string
  reason?: string
  data?: Record<string, unknown>
}
```

### 3.6 `core/runtime/lifecycle.ts`

State transition table (the only legal transitions):

| from         | event           | to                                 |
| ------------ | --------------- | ---------------------------------- |
| `idle`       | `start()`       | `running`                          |
| `running`    | `pause(reason)` | `paused`                           |
| `running`    | `crash(err)`    | `crashed`                          |
| `running`    | `stop()`        | `stopped`                          |
| `paused`     | `resume()`      | `running`                          |
| `paused`     | `stop()`        | `stopped`                          |
| `crashed`    | `recover()`     | `recovering` (only if budget left) |
| `crashed`    | `stop()`        | `stopped`                          |
| `recovering` | `recovered()`   | `running`                          |
| `recovering` | `crash(err)`    | `crashed`                          |

Out-of-table calls throw an `IllegalTransitionError` — caller bug, not user error.

- Restart budget: 5 within 1h, sliding window
- `subscribe(fn)` returns unsubscribe; called synchronously on every transition
- `snapshot()` returns the current `LifecycleSnapshot`

---

## 4. Integration points (after subagent work)

### 4.1 `engine.ts`

- Take `Lifecycle` as a constructor injection (defaults to `new Lifecycle()` if not provided)
- Replace `console.log/error` with `this.log = getLogger('engine')` / `this.log.child('engine.tick')`
- Wrap `start()` with `lifecycle.start()`; on early `measureLayout` failure → `lifecycle.crash(err)`; on `stop()` → `lifecycle.stop()`
- Keep `LogEmitter` callback for renderer compat (Phase 5 will replace)
- For each tick, allocate a `traceId` and pass to logger context

### 4.2 `ai-client.ts`

- Replace `console.error` with `getLogger('ai-client').error`
- No behavior change

### 4.3 `local-hooks.ts`

- Replace `console.log/warn/error` with `getLogger('hooks.local').<level>`
- No behavior change

### 4.4 `rpa-device.ts`

- Replace `console.log/error` with `getLogger('device.rpa').<level>`
- No behavior change

### 4.5 `main/index.ts`

- Boot order:
  1. `configureLogger({ env: app.isPackaged ? 'prod' : 'dev', logsDir: path.join(app.getPath('userData'), 'logs') })`
  2. Install `process.on('unhandledRejection' | 'uncaughtException')` → `logger.error` then escalate to lifecycle.pauseForHuman(reason='process_error')
  3. Construct lifecycle, wire `lifecycle.subscribe()` to:
     - `mainWindow.webContents.send('engine:state', snapshot)`
     - `powerSaveBlocker.start()` if state === 'running', `stop()` otherwise
- Add IPC handlers:
  - `diagnostics:getLogBuffer` — returns ring buffer contents (Phase 5 UI uses this)
  - `diagnostics:getMetricsSnapshot` — returns metrics snapshot
  - Keep all existing IPC handlers untouched

---

## 5. Test plan

| File                                 | Coverage target |
| ------------------------------------ | --------------: |
| `core/observability/logger.test.ts`  |           ≥ 90% |
| `core/observability/metrics.test.ts` |           ≥ 90% |
| `core/observability/trace.test.ts`   |           ≥ 90% |
| `core/runtime/lifecycle.test.ts`     |           ≥ 90% |

Test fixtures:

- Logger: in-memory sink to capture records; assert format, redaction, child phase propagation
- Metrics: counter increments, histogram percentile math, label stringification
- Trace: id format / uniqueness / span nesting
- Lifecycle: every legal transition + every illegal transition (asserts throw), restart-budget exhaustion, subscription fires once per transition

Existing tests (78) must keep passing. `engine.test.ts` will need a mock Logger/Lifecycle injected — extend the FakeDevice fixture, no behavior assertions change.

---

## 6. Out of scope / decisions

- **Watchdog**：spec 把 watchdog 列在 Phase 1，但 watchdog 真正发挥作用需要熔断信号
  （来自 Phase 3 的 anti-detection），单独做一半是死代码。决定下沉到 Phase 3 与
  circuit-breaker 一起实现。Phase 1 只暴露 `lifecycle.crashed → recover()` 接口，
  watchdog 之后从那里挂。
- **Redact 函数**：Phase 1 只做最小白名单（`apiKey`/`api_key`/`token`/`password`/`secret`）
  - 强类型的"敏感字段标注"。完整的隐私字段树（聊天内容等）在 Phase 5 导出诊断包时再做。
- **Trace 嵌套 span**：interface 留出来，Phase 1 只用 `traceId` 单层。完整 nested span
  在 Phase 2（Brain）有多步推理时再实现。
- **Diagnostics 面板**：Phase 5 做。Phase 1 只暴露 IPC 通道供后续消费。

---

## 7. 多 Agent 分工

| Stream           | Subagent          | 文件                                                               |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| A: Observability | claude-4.6-sonnet | `core/observability/{types,logger,metrics,trace,index}.ts` + tests |
| B: Lifecycle     | claude-4.6-sonnet | `core/runtime/{types,lifecycle,index}.ts` + tests                  |
| Integration      | 主 session        | 修改 5 个现有文件 + 新 IPC                                         |

文件边界完全不重叠 → 不会冲突。两个 subagent 完成后，主 session 做集成 + PR。
