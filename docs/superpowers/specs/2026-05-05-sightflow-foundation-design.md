# SightFlow Desktop Agent — 基座加固设计（Plan B）

- 日期：2026-05-05
- 作者：（基于用户提供方向，与 AI 协作产出）
- 上游项目：https://github.com/sightflow-dev/sightflow-desktop-agent
- 适用版本基线：`main` HEAD（README + package.json 已读，主代码已采样调研）
- 状态：草案，待用户最终确认 → 进入 implementation plan

---

## 1. 背景与目标

### 1.1 项目现状

SightFlow Desktop Agent 是一个基于 Electron + VLM（视觉大模型）的桌面 RPA Agent，
当前主用例是"AI 自动回复微信 / 企业微信"。技术路线为：截图 → VLM 定位坐标
→ robotjs 模拟点击/打字。

调研发现的 10 项主要短板（按风险从高到低）：

1. 测试基础设施完全缺失（仅手动 CLI 脚本，无 vitest/jest，无 CI workflow）
2. 业务逻辑紧耦合：`core/engine.ts` 写死"微信"流程语义
3. AI Provider 硬绑定火山方舟（baseURL/model/prompts 写死）
4. 配置/状态管理薄弱（无 zod 校验，API Key 明文落盘）
5. 前端单文件化（App.tsx ~430 行 + index.css ~700 行）
6. 可观测性薄弱（裸 console.log，无结构化日志，无指标）
7. 跨平台风险（robotjs 原生编译，三个重叠的窗口管理库）
8. Electron 安全（`sandbox: false`，无 CSP，IPC 无 schema 校验）
9. 工程化空白（无 commitlint/husky/.nvmrc/changelog 流程）
10. 文档/DX 缺失（README 极简，无 architecture/contribution/ADR）

### 1.2 用户目标（已澄清）

- **当下**：把"微信自动回复"这件事做到自用工业级
- **未来**：在基座上接更强大的 Agent AI（带记忆、工具调用、多步推理）做聊天
- **运行场景**：自己用，但要 7×24 跑（家里 / 公司 / 云桌面）
- **关键约束**：
  - 必须稳定、可恢复
  - 必须可观测（出问题能查）
  - **必须反封号**（被微信识别风险要系统性降低）
- **不做**：横向拓展更多 IM、通用 RPA 平台、插件市场、产品化（installer/auto-update/error reporting）

### 1.3 本设计的目标

把现有项目改造成一个**专门为长时间运行的微信自动回复 agent 设计的稳健 runtime**：
- 大脑（Brain）可替换：今天是简单 VLM，明天是带记忆 + 工具调用的强 Agent
- 反封号是一等公民（系统性中间件，每次设备调用都过）
- 长跑稳定（watchdog + 状态机 + 自恢复 + 熔断）
- 全本地可观测（结构化日志 + 指标 + 诊断面板）
- 不破坏现有可工作的 RPA 实现（`vision-utils` / `has-unread` / robotjs 调用都保留）

### 1.4 非目标（明确不做）

- 多 IM 适配（不抽象到 Telegram/Slack/Discord/Lark 等）
- 通用 RPA 工作流编排
- 第三方插件 marketplace / sandbox
- 自动更新（auto-update）
- 外部错误上报（Sentry / Datadog）
- Linux 端主动支持（保留 `build:linux` 脚本，不测）
- 切换底层输入注入实现（保留 robotjs，仅在 humanizer 层包装；如未来证明 robotjs 不行再换底）
- 大改 `vision-utils.ts`（行为不动，仅作为 brain 内部依赖）

---

## 2. 总体架构

### 2.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer (React)                         │
│   Views: control / settings / diagnostics                   │
│   Store (zustand) | i18next | ErrorBoundary | Router        │
└──────────────────────────┬──────────────────────────────────┘
                           │ IPC (typed + zod-validated)
┌──────────────────────────▼──────────────────────────────────┐
│                    Main process (Electron)                  │
│   IPC handlers (settings/engine/diagnostics)                │
│   secure-store (keytar)  |  permissions                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Runtime (场景无关)                       │
│   Engine (lifecycle FSM) | Watchdog | Observability         │
└────┬───────────────┬───────────────┬────────────────────────┘
     │               │               │
     │ 看            │ 想            │ 做
┌────▼─────┐   ┌─────▼──────┐  ┌─────▼─────────┐
│ Scenario │   │ AgentBrain │  │ Anti-Detection│
│ (wechat) │   │ (vlm/...)  │  │   Policy      │
└────┬─────┘   └─────┬──────┘  └─────┬─────────┘
     │               │               │
     │               ▼               ▼
     │        ┌──────────────┐  ┌──────────────┐
     │        │  Providers   │  │ DesktopDevice│
     │        │  (OpenAI 兼容)│  │  (robotjs)   │
     │        └──────────────┘  └──────────────┘
     │
     └─→ 调用 device & brain 拼装"微信自动回复"语义
```

**核心思想**：runtime 是场景无关的循环引擎，每一轮"看 → 想 → 做"中间都过
anti-detection 中间件；"想"这一步是 `AgentBrain` 接口，今天是 `vlm-brain`，
未来加更强的 Agent，只要再实现一个 `AgentBrain` 注入即可。

### 2.2 目录结构

```
src/
├── main/
│   ├── index.ts                精简：只做 IPC 注册 + window 创建
│   ├── ipc/                    NEW：IPC handlers 拆分
│   │   ├── settings.ts
│   │   ├── engine.ts
│   │   └── diagnostics.ts
│   ├── permission.ts
│   └── secure-store.ts         NEW：keytar 包装 + zod schema 校验
│
├── core/
│   ├── runtime/                NEW：通用 Agent runtime
│   │   ├── engine.ts
│   │   ├── lifecycle.ts        状态机
│   │   ├── watchdog.ts
│   │   └── types.ts
│   │
│   ├── brain/                  NEW：AI 大脑抽象
│   │   ├── types.ts            AgentBrain / BrainContext / BrainDecision
│   │   ├── vlm-brain.ts        当前实现（从 local-hooks 迁移）
│   │   ├── providers/
│   │   │   ├── types.ts        AIProvider 接口
│   │   │   └── openai-compat.ts
│   │   └── prompts/
│   │       ├── reply.ts
│   │       └── vlm-detect.ts
│   │
│   ├── anti-detection/         NEW：反封号子系统
│   │   ├── humanizer.ts
│   │   ├── rate-limiter.ts
│   │   ├── schedule.ts
│   │   ├── circuit-breaker.ts
│   │   ├── policy.ts
│   │   └── types.ts
│   │
│   ├── scenarios/              NEW：场景实现
│   │   └── wechat/
│   │       ├── scenario.ts     从 engine.ts 抽出来的"微信语义"步骤
│   │       ├── has-unread.ts   迁过来
│   │       ├── window-utils.ts 迁过来
│   │       └── ...
│   │
│   ├── device/                 整理后：设备抽象
│   │   ├── types.ts            DesktopDevice 接口
│   │   ├── rpa-device.ts       robotjs 实现
│   │   ├── mock-device.ts
│   │   └── rpa/                screenshot / input / vision 等工具（vision-utils 内容不动）
│   │
│   └── observability/          NEW：可观测性
│       ├── logger.ts           electron-log 包装 + JSON sink + 轮转
│       ├── metrics.ts
│       └── trace.ts            trace context（为未来 ReAct 预留）
│
├── preload/
│   └── index.ts                contextBridge 白名单暴露
│
└── renderer/
    └── src/
        ├── App.tsx             轻拆：只做路由 + 全局状态
        ├── views/
        │   ├── control.tsx
        │   ├── settings.tsx
        │   └── diagnostics.tsx
        ├── components/
        ├── store/              zustand
        ├── i18n/               i18next + zh.json / en.json
        └── error-boundary.tsx
```

### 2.3 数据流（一轮主循环）

```
1. Watchdog.beat()
2. Engine.tick(traceId):
   2.1 Schedule.isInWorkWindow()? no → sleep 然后 return
   2.2 CircuitBreaker.shouldStop()? yes → lifecycle.pauseForHuman()
   2.3 ctx = scenario.perceive()                  # 截图 + 当前对话信息
   2.4 for await decision of brain.think(ctx):
       - thinking → logger.trace
       - skip → break
       - wait  → policy.wait(ms); continue
       - escalate → lifecycle.pauseForHuman(); break
       - reply →
           rateLimiter.tryAcquire() ? continue : skip+observe
           policy.beforeAction(action)
           scenario.executeAction(action)         # device 调用都包了 humanizer
           policy.afterAction(action)
           breaker.observe(success/failure)
           metrics.counter('replies.sent_total')
   2.5 scenario.observeAfterReply()               # 设置 chat baseline
3. scenario.waitForNextUnread()                   # 现有逻辑保留，封装到 scenario
```

---

## 3. 关键模块设计

### 3.1 AgentBrain 抽象

```ts
// core/brain/types.ts
export interface BrainContext {
  screenshot: string                       // base64
  conversation?: {
    contactId?: string
    contactName?: string
    isGroup?: boolean
  }
  memory?: BrainMemory
  tools?: readonly BrainTool[]
  traceId: string
}

export type BrainDecision =
  | { kind: 'reply'; actions: ReplyAction[] }
  | { kind: 'skip'; reason?: string }
  | { kind: 'wait'; ms: number; reason?: string }
  | { kind: 'escalate'; reason: string }

export interface ThinkingTrace {
  kind: 'thinking'
  content: string
  tool?: { name: string; args: unknown; result?: unknown }
}

export interface AgentBrain {
  readonly id: string
  init?(): Promise<void>
  think(ctx: BrainContext): AsyncIterable<BrainDecision | ThinkingTrace>
  dispose?(): Promise<void>
}

export interface BrainMemory {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown): Promise<void>
  appendConversation(msg: ConversationMsg): Promise<void>
  recentConversation(n: number): Promise<ConversationMsg[]>
}

export interface BrainTool {
  name: string
  description: string
  schema: unknown   // zod schema
  execute(args: unknown): Promise<unknown>
}

// core/brain/providers/types.ts
export interface AIMessage { role: 'system' | 'user' | 'assistant'; content: string | unknown[] }
export interface AIProvider {
  callText(messages: AIMessage[]): Promise<string>
  callVision(prompt: string, image: string): Promise<string>
  callTool?(messages: AIMessage[], tools: BrainTool[]): Promise<ToolCall>  // 未来 ReAct 用
}
```

**今日实现**（替代 `local-hooks.ts` 当前 brain 部分）：

```ts
// core/brain/vlm-brain.ts
export class VLMBrain implements AgentBrain {
  id = 'vlm-simple'
  constructor(private provider: AIProvider, private prompts: PromptSet) {}
  async *think(ctx: BrainContext) {
    yield { kind: 'thinking', content: '分析截图...' }
    const text = await this.provider.callVision(this.prompts.reply, ctx.screenshot)
    if (!text || text.trim() === '[SKIP]') {
      yield { kind: 'skip', reason: 'self-loop guard or non-conversational' }
      return
    }
    yield { kind: 'reply', actions: [{ type: 'text', content: text.trim() }] }
  }
}
```

**Provider 实现**：用 `@ai-sdk/openai` 的 `createOpenAICompatible`（已在 deps 中），
一份代码同时支持火山 / OpenAI / Claude / Ollama / Together。火山 baseURL 仍可作为
默认值，但通过设置可切换。

### 3.2 Anti-Detection Policy

由 5 个独立模块组合：

#### 3.2.1 Humanizer（拟人化）
- 包装 `device.click / sendMessage` 等原始操作
- 配置项：点击前后随机延迟、坐标抖动、鼠标轨迹（bezier）、打字 CPS、标点后停顿、偶尔打错退格、偶尔长 pause、"读消息"延迟
- 当前 engine.ts 里零散的 `sleep(150 + Math.random() * 100)` 全部抽到这里集中管理

#### 3.2.2 RateLimiter（限速）
- token-bucket 实现，状态持久化到 electron-store
- 配置：全局 perHour、单联系人 perDay、最小间隔 minIntervalMs、群聊策略、新好友冷却
- 默认值：30/h，20/contact/day，8s minInterval（**可在 UI 调**）

#### 3.2.3 Schedule（工作时间窗）
- 工作窗口（按周）+ 静默时段 + 随机"AFK"模拟
- 不在窗口内时**整个进程"装睡"**：不轮询、不截图、不调 AI

#### 3.2.4 CircuitBreaker（熔断）

监控信号：

| 信号 | 默认阈值 | 含义 |
|---|---|---|
| 连续 AI 失败 | 5 次 | 网络/key 出问题或被风控 |
| 连续 RPA 失败 | 3 次 | 微信界面变了或被切走 |
| 同一回复重复出现 | 3 次 | AI 卡死或被识别 |
| 截图哈希长时间不变 | 5 分钟 | 微信被冻结或弹了登录框 |
| 出现关键词（自定义）| 任意 | 比如截图里出现"账号异常"立即停 |

熔断后 → `lifecycle.pauseForHuman(reason)`，**绝不自动重启**（重启可能加剧风险）。

#### 3.2.5 Policy（组合层）

```ts
export class AntiDetectionPolicy {
  async beforeReply(ctx: BrainContext): Promise<{ proceed: boolean; reason?: string }>
  async beforeAction(action: ReplyAction): Promise<void>
  async afterAction(action: ReplyAction): Promise<void>
  observe(signal: BreakerSignal): void
}
```

**关键不变量**（设计上保证，通过 TS 类型 + module export 可见性约束）：
- 所有 device 调用必须经过 `policy.beforeAction/afterAction`
- 所有"是否要回"的决策都在 `policy.beforeReply` 之后才发生
- 熔断后绝不自动重启
- 配置全部从 zod schema 驱动，UI 上有"反封号设置"页

### 3.3 Lifecycle 状态机

```
        ┌──────────┐
 start →│   idle   │
        └────┬─────┘
             │ initLayout ok
        ┌────▼─────┐
        │ running  │◄─────────┐
        └─┬─────┬──┘          │
breaker open  user pause      │ resume
        ┌─▼─────▼──┐          │
        │  paused  │──────────┘
        └────┬─────┘
        fatal err│
        ┌────▼─────┐  retry budget?  ┌──────────┐  ┌──────────┐
        │  crashed │────► yes ──────►│recovering│──►│ running  │
        │          │────► no ───────►│  stopped │
        └──────────┘                  └──────────┘
```

6 个状态：`idle | running | paused | crashed | recovering | stopped`

- **暂停 vs 停止严格区分**：用户暂停可手动恢复；熔断暂停只能用户人工 review 后恢复；fatal stop 不可恢复
- 状态转换都打 INFO 日志 + 发 IPC 事件给 UI

### 3.4 Watchdog

```ts
export interface WatchdogOpts {
  timeoutMs: number              // 60_000：多久没心跳算挂
  maxRestarts: number            // 5
  restartWindowMs: number        // 3600_000
  cooldownMs: number             // 30_000，指数退避：30s → 1min → 2min → 4min...
  onTimeout: () => Promise<'restart' | 'stop'>
}
```

- 1 小时内最多 5 次重启，超过 fatal stop
- 重启前先观察熔断状态，熔断中不重启
- 不做 OS 级独立 launcher（YAGNI）

### 3.5 Observability

#### 3.5.1 Logger
```ts
export interface LogRecord {
  ts: string                          // ISO 8601
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  phase: string                       // 'engine.tick' | 'brain.think' | 'device.click' ...
  traceId: string
  msg: string
  data?: Record<string, unknown>
  err?: { name: string; message: string; stack?: string }
}
```

三个 sink 并行：
- Console（dev only，彩色）
- JSON file（prod）：`<userData>/logs/sightflow-YYYY-MM-DD.jsonl`，按日切，最多保 30 天
- Ring buffer（最近 1000 条在内存，UI 实时显示用）

#### 3.5.2 Metrics（自实现 ~50 行）
```ts
class Metrics {
  counter(name: string, labels?: Record<string, string>): void
  histogram(name: string, value: number, labels?: Record<string, string>): void
  snapshot(): MetricsSnapshot
}
```

要追踪：`engine.tick.duration_ms`、`brain.think.duration_ms`、`vlm.detect.duration_ms`、
`replies.sent_total`、`replies.skipped_total{reason}`、`breaker.trips_total{signal}`、
`device.errors_total{op}`、`rate_limiter.rejected_total{scope}`。

#### 3.5.3 Diagnostics 面板（UI）
新页 `views/diagnostics.tsx`，单页展示：
- 顶部：状态条（当前 lifecycle 状态、心跳、运行时长、本时段重启次数）
- 中部：最近 1 小时核心指标
- 底部：实时日志（按 phase / level / 关键字过滤）
- 一键"导出诊断包"：当前会话日志 + metrics snapshot + 脱敏 settings 打成 zip

### 3.6 配置 + 安全

- 所有 settings 走 `zod` schema（`SettingsSchema`），主进程加载时校验，校验失败 fall back 默认值并 warn
- API Key 用 `keytar` 走 OS keychain，`secure-store.ts` 包装；`electron-store` 只存非敏感配置
- IPC 用统一的 `defineChannel(name, requestSchema, responseSchema)` 包装，主进程收到请求先 zod 校验
- preload 用 contextBridge **只暴露白名单 channel**
- Electron：`contextIsolation: true`、渲染进程 `sandbox: true`、加 CSP meta、禁 `webview`
- Settings 配置分层：defaults → user-settings.json → runtime overrides

### 3.7 前端轻拆

- 引入 `react-router-dom` 做路由（HashRouter，文件协议下也能用）
- 引入 `zustand` 做全局 state：engine 状态、log ring buffer、metrics snapshot、settings cache
- 拆 `App.tsx` → `views/{control,settings,diagnostics}.tsx` + `components/`
- 加 React `ErrorBoundary` 包整个 App
- `i18n.ts` → `i18next` + `i18next-browser-languagedetector`，文案拆 `i18n/zh.json`、`i18n/en.json`
- CSS：保留手写风格，但拆成 `index.css`（reset + 变量）+ 各 view 的 `.module.css`
- 不引入 UI 组件库（保持包体小）

### 3.8 测试

- `vitest` + `@vitest/coverage-v8`
- 覆盖率目标：`core/` ≥ 70%，`renderer/` 不强制
- **单元测试**（必做）：
  - anti-detection: humanizer 随机分布、rate-limiter token-bucket、circuit-breaker 阈值、schedule 时间窗
  - runtime: lifecycle 状态转换、watchdog 重启预算
  - brain: vlm-brain（mock provider）
  - observability: logger sinks、metrics snapshot
- **集成测试**：engine + mock-device + 假 brain，跑完整一轮"看-想-做"，断言决策 / 副作用 / 日志
- **E2E**：暂不做（electron e2e 维护成本太高）；保留并扩充现有 `core/rpa/tests/*.ts` 作为人工冒烟脚本

### 3.9 CI / 工程化

- **GitHub Actions**：
  - `lint+typecheck` job（ubuntu）
  - `test` job（windows + macOS 矩阵）
  - `build-verify` job（windows + macOS 不发布只验证构建）
- `husky` + `lint-staged`：pre-commit 跑 lint + typecheck + 受影响测试
- `commitlint` + conventional commits
- `.nvmrc` 锁定 Node 20 LTS（视 robotjs 兼容性微调）
- `.env.example` 列所有非敏感配置项
- `docs/adr/` — 重要架构决策都留 ADR（含"为什么继续用 robotjs"等）

---

## 4. 错误处理与失败模式

| 失败 | 处理 |
|---|---|
| AI HTTP 失败（网络/超时/5xx）| 单次失败：retry 2 次（指数退避）。连续 5 次：`circuit-breaker` open → pause |
| AI 返回格式错（非预期）| 走 `kind: 'skip'`（reason='ai_invalid_format'），观测计入 metrics |
| VLM 定位失败 | 沿用现有逻辑（清缓存 + 重新检测）；连续 3 次：breaker open |
| `robotjs` 调用失败 | 本次 action 跳过，记录失败计数；连续多次：breaker open |
| 截图失败（权限丢失） | logger.error + lifecycle.pauseForHuman |
| 配置 schema 校验失败 | warn + fallback 默认值；UI 提示用户修正 |
| Watchdog 触发 | 走重启预算逻辑；预算耗尽：fatal stop |
| 主进程 unhandledRejection / uncaughtException | logger.error + 把当前会话日志 dump 到磁盘 + lifecycle.pauseForHuman |
| 渲染进程异常 | ErrorBoundary 兜底，面板上展示错误详情 + 引导用户导出诊断包 |
| 微信弹"账号异常"对话框 | breaker.observe('keyword_match', '账号异常') → 立即 pause |

---

## 5. 安全模型

威胁模型（聚焦自用、不给他人装）：
- T1：API Key 被本机其他进程读取 → 用 OS keychain（mitigate）
- T2：恶意 IPC 调用绕过校验 → preload 白名单 + zod schema 校验（mitigate）
- T3：渲染进程被 XSS（理论上不会，无远端内容） → contextIsolation + sandbox + CSP（defense in depth）
- T4：日志泄露 API Key / 隐私聊天内容 → logger 写出前过 redact 函数（敏感字段强制脱敏）
- T5：诊断包导出泄露隐私 → 导出时强制脱敏 + 显式确认

非目标：
- 不防本地文件系统访问（自用，OS 用户已经是信任边界）
- 不防硬件层攻击

---

## 6. 范围与里程碑（实施顺序）

按**风险递减**和**依赖关系**排序，分 6 阶段。每阶段都可独立 review/合并，不必一次性大破大立。

- **Phase 0 — 工程化基础（约 2-3 天）**
  - Vitest + 覆盖率配置
  - GitHub Actions 三 job（lint+typecheck / test / build-verify）
  - husky + lint-staged + commitlint + .nvmrc + .env.example
  - 基础测试骨架（不要求覆盖率，只要管道跑通）

- **Phase 1 — Observability + Lifecycle（约 3-4 天）**
  - `core/observability/` 三件套（logger/metrics/trace）
  - `core/runtime/lifecycle.ts` 状态机
  - 替换现有 `console.log` 为结构化 logger（不动业务逻辑）
  - 主进程 `unhandledRejection` / `uncaughtException` hook
  - 接入 Electron `powerSaveBlocker`（仅在 `running` 状态阻止系统睡眠）

- **Phase 2 — Brain 抽象（约 4-5 天）**
  - `core/brain/types.ts` 接口
  - `core/brain/providers/openai-compat.ts`（用 ai-sdk）
  - `core/brain/vlm-brain.ts` 把 `local-hooks.ts` 的 brain 部分迁过来
  - Engine 改为消费 `AgentBrain`（不改外部行为）
  - 单元测试：vlm-brain（mock provider） + 集成测试 engine + mock-device + vlm-brain

- **Phase 3 — Anti-Detection（约 5-7 天）**
  - `humanizer` / `rate-limiter` / `schedule` / `circuit-breaker` / `policy`
  - Engine 接入 policy（所有 device 调用过 humanizer，所有循环开始过 policy.beforeReply）
  - 把现有零散随机化逻辑迁到 humanizer
  - 单元测试覆盖每个子模块
  - 默认配置文件 + 配置 schema

- **Phase 4 — Scenarios/Wechat 重构（约 3-4 天）**
  - 把 `engine.ts` 里的微信语义抽到 `scenarios/wechat/scenario.ts`
  - 把 `has-unread.ts` / `window-utils.ts` / 其他微信特化代码归到 `scenarios/wechat/`
  - Engine 瘦身成场景无关的循环
  - 集成测试：用 mock-device 驱动 wechat scenario 走完一轮

- **Phase 5 — 前端轻拆 + Diagnostics 面板（约 4-5 天）**
  - 引入 react-router、zustand、i18next
  - 拆 App.tsx 为 views + components + store
  - 新增 `views/diagnostics.tsx`（实时日志 + 指标 + 一键导出诊断包）
  - ErrorBoundary
  - 反封号设置页

- **Phase 6 — 配置 + 安全加固（约 2-3 天）**
  - zod schema 化所有配置
  - keytar 替换 API Key 存储
  - IPC 全部走 typed channel + zod 校验
  - Electron 安全开关（contextIsolation/sandbox/CSP）
  - 文档：architecture.md / contribution.md / 第一批 ADR

**总计预估 23-31 工作日（约 4-6 周日历周，单人节奏）**。每个 phase 都包含对应测试，
不是单纯写代码工时。建议每个 phase 单独成一份 implementation plan + 单独 PR，便于
review 和回滚。

---

## 7. 兼容性与迁移

- 所有现有可工作的功能在每个 phase 末都必须仍然可工作（fork 后用户能正常跑微信回复）
- 现有 `core/rpa/tests/*.ts` 手动冒烟脚本保留（不删，扩充）
- `package.json` script 不破坏（`npm run dev` / `build:win` / `build:mac` 不变）
- 设置数据迁移：旧的 `electron-store` settings 第一次启动时迁移到新 schema + keychain
- patch-package 现状保留（说明对应 patch 写入 ADR）

---

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| robotjs 在 Electron 39 的兼容问题（已用 patch-package）| Phase 0 验证现有 patch 仍有效 + 写 ADR 记录 |
| keytar 在 Windows 老版本可能装不上 | 第一次启动失败时 fallback 到 electron-store + 显著告警 |
| 火山方舟 API 变动（私有 thinking 字段等）| openai-compat provider 只用最小公约协议；火山特殊参数走可选配置 |
| 反封号策略默认值的合理性（30/h 等）| 默认值偏保守；UI 给"建议预设"（保守 / 平衡 / 激进）；保留可观测性以便用户根据实际数据调 |
| 7×24 跑期间机器睡眠 | Phase 1 加入 `powerSaveBlocker`（仅在 lifecycle 处于 `running` 时阻止系统睡眠；进入静默窗口或 paused 状态自动释放） |
| Electron 版本升级带来的破坏 | Phase 6 之后冻结依赖版本；用 renovate 手动 review |

开放问题（Phase 之间根据实际情况决策）：
- **是否引入 OCR**：当前 brain context 不放 ocrText（删除现有未用字段）。如果 Phase 2-3
  发现 brain 决策需要更多结构化文本信息，再作为 BrainTool 加回。
- **memory 用什么后端**：Phase 2 先不实现 BrainMemory（接口预留 + null 实现）。
  当用户接"更强 Agent"时，再决定 sqlite / 文件 / 向量库。
- **多账号支持**：当前不做。如果未来需要，需引入 Profile 概念，影响 settings schema、
  rate-limiter 状态隔离、日志分目录。

---

## 9. 验收标准

- 每个 phase 结束时 CI 全绿（lint + typecheck + test + build-verify）
- `core/` 测试覆盖率 ≥ 70%
- 单次手动冒烟测试：在真实微信环境下跑 ≥ 4 小时不挂、不被识别
- 异常注入测试：模拟"AI 连续失败" / "RPA 连续失败" / "进入静默时段" / "watchdog 触发"
  四种场景，断言走到正确的 lifecycle 状态
- Diagnostics 面板能展示当前状态、最近指标、实时日志，一键导出诊断包可解开看
- API Key 不出现在任何明文文件 / 日志中（keychain 之外）
- 项目克隆后 `npm install && npm run dev` 一把过（无需 patch 之外的手动操作）

---

## 10. 后续（不在本设计范围）

为"未来加更强大的 Agent AI"留的钩子（**仅设计上预留，不实现**）：
- `BrainMemory` 接口（持久化对话历史 / 工作记忆）
- `BrainTool` 接口（工具调用，比如查知识库 / 调外部 API / 查日历）
- `AIProvider.callTool` 可选方法（function calling）
- `core/observability/trace.ts` 接口已为嵌套 span 预留（Phase 1 实现；可直接给未来 ReAct 多步推理画 trace）

接更强 Agent 时的预期工作量：实现一个 `ReActBrain implements AgentBrain` + 接 memory/tools，
**估计 1-2 周**，无需动 runtime / anti-detection / scenario / device 任何代码。
