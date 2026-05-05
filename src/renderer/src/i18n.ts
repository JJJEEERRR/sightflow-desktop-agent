// src/renderer/src/i18n.ts
// 简单的中英文国际化

export type Locale = 'zh' | 'en'

const translations = {
  zh: {
    // Header
    'app.title': 'SightFlow Desktop',
    'app.version': 'v0.1.0',

    // Tabs
    'tab.control': '控制',
    'tab.settings': '设置',

    // Control
    'control.status': '引擎状态',
    'status.idle': '待命',
    'status.running': '运行中',
    'status.error': '异常',
    'control.start': '启动引擎',
    'control.stop': '停止引擎',
    'control.start.nokey': '请先在设置页填写 API Key',
    'control.log': '运行日志',
    'control.log.empty': '引擎尚未启动',
    'control.log.thinking': '思考',
    'control.log.reply': '回复',
    'control.log.skip': '跳过',
    'control.log.error': '错误',

    // Settings
    'settings.ai': 'AI 模型配置',
    'settings.apiKey': 'API Key',
    'settings.apiKey.placeholder': '输入你的豆包 API Key',
    'settings.apiKey.hint': '在火山引擎控制台获取',
    'settings.model': '模型',
    'settings.model.placeholder': 'doubao-seed-1-6-251015',
    'settings.baseURL': 'Base URL',
    'settings.baseURL.placeholder': 'https://ark.cn-beijing.volces.com/api/v3',
    'settings.baseURL.hint': '默认即可，如需自定义代理可修改',
    'settings.systemPrompt': 'System Prompt',
    'settings.systemPrompt.placeholder':
      '你是一个微信自动回复助手。根据截图中的聊天内容，生成合适的回复...',
    'settings.testConnection': '测试连接',
    'settings.testConnection.testing': '测试中...',
    'settings.testConnection.success': '连接成功',
    'settings.testConnection.fail': '连接失败',
    'settings.save': '保存配置',
    'settings.saved': '配置已保存',

    'settings.general': '通用设置',
    'settings.language': '语言',

    // Diagnostics
    'diag.title': '诊断',
    'diag.lifecycle.title': '引擎状态',
    'diag.lifecycle.state': '当前状态',
    'diag.lifecycle.enteredAt': '进入时间',
    'diag.lifecycle.restartBudget': '重启预算',
    'diag.lifecycle.lastError': '最近错误',
    'diag.lifecycle.windowEndsAt': '窗口结束于',
    'diag.logs.title': '实时日志',
    'diag.logs.empty': '暂无日志记录',
    'diag.logs.filterLevel': '等级',
    'diag.logs.filterPhase': '模块',
    'diag.logs.filterAll': '全部',
    'diag.transitions.title': '最近状态转换',
    'diag.transitions.empty': '尚未发生转换',
    'diag.export': '导出诊断包',
    'diag.export.success': '诊断包已下载',
    'diag.errorBoundary.title': 'Renderer 崩溃了',
    'diag.errorBoundary.hint': '把下面的错误信息复制给开发者，或导出诊断包附在 issue 里',
    'diag.errorBoundary.copy': '复制错误',
    'diag.errorBoundary.reload': '刷新',

    // Anti-detection (policy) settings
    'policy.title': '反封号设置',
    'policy.openSettings': '反封号设置 →',
    'policy.tripped': '熔断器已触发',
    'policy.resetBreaker': '重置熔断器',
    'policy.preset.label': '预设',
    'policy.preset.conservative': '保守',
    'policy.preset.balanced': '平衡',
    'policy.preset.aggressive': '激进',
    'policy.section.humanizer': '人性化',
    'policy.section.rateLimiter': '限速',
    'policy.section.schedule': '工作时间',
    'policy.section.breaker': '熔断器',
    'policy.field.enabled': '启用',
    'policy.field.preActionDelayMs': '前置延迟 (ms)',
    'policy.field.postActionDelayMs': '后置延迟 (ms)',
    'policy.field.clickJitterPx': '点击抖动 (px)',
    'policy.field.charsPerSecond': '打字速度 (字/秒)',
    'policy.field.punctuationPauseMs': '标点停顿 (ms)',
    'policy.field.typoProbability': '错字率',
    'policy.field.longPauseProbability': '长停顿概率',
    'policy.field.longPauseMs': '长停顿时长 (ms)',
    'policy.field.readDelayMs': '阅读延迟 (ms)',
    'policy.field.globalPerHour': '每小时上限',
    'policy.field.perContactPerDay': '每联系人每天',
    'policy.field.minIntervalMs': '最小间隔 (ms)',
    'policy.field.newContactCooldownMs': '新联系人冷却 (ms)',
    'policy.field.afkProbability': 'AFK 概率',
    'policy.field.afkDurationMs': 'AFK 时长 (ms)',
    'policy.field.windows': '工作窗口 (JSON)',
    'policy.field.consecutiveAiFailures': '连续 AI 失败',
    'policy.field.consecutiveRpaFailures': '连续 RPA 失败',
    'policy.field.duplicateReplyCount': '重复回复次数',
    'policy.field.screenshotFreezeMs': '截图冻结 (ms)',
    'policy.field.bannedKeywords': '封禁关键字 (一行一个)',
    'policy.range.to': '到',
    'policy.invalidRange': '范围下限不能大于上限',
    'policy.invalidWindowsJson': 'windows JSON 解析失败',
    'policy.save': '保存',
    'policy.reloadDefaults': '重置编辑',
    'policy.saved': '反封号配置已保存',
    'policy.saveFailed': '保存失败',
    'policy.resetBreakerDone': '熔断器已重置',

    // Toast
    'toast.engineStarted': '引擎已启动',
    'toast.engineStopped': '引擎已停止',
    'toast.startFailed': '启动失败',
    'toast.copied': '已复制到剪贴板'
  },
  en: {
    'app.title': 'SightFlow Desktop',
    'app.version': 'v0.1.0',

    'tab.control': 'Control',
    'tab.settings': 'Settings',

    'control.status': 'Engine Status',
    'status.idle': 'Idle',
    'status.running': 'Running',
    'status.error': 'Error',
    'control.start': 'Start Engine',
    'control.stop': 'Stop Engine',
    'control.start.nokey': 'Please set API Key in Settings first',
    'control.log': 'Activity Log',
    'control.log.empty': 'Engine not started yet',
    'control.log.thinking': 'Thinking',
    'control.log.reply': 'Reply',
    'control.log.skip': 'Skip',
    'control.log.error': 'Error',

    'settings.ai': 'AI Model Configuration',
    'settings.apiKey': 'API Key',
    'settings.apiKey.placeholder': 'Enter your Doubao API Key',
    'settings.apiKey.hint': 'Get it from Volcengine Console',
    'settings.model': 'Model',
    'settings.model.placeholder': 'doubao-seed-1-6-251015',
    'settings.baseURL': 'Base URL',
    'settings.baseURL.placeholder': 'https://ark.cn-beijing.volces.com/api/v3',
    'settings.baseURL.hint': 'Defaults are fine; override if you use a proxy',
    'settings.systemPrompt': 'System Prompt',
    'settings.systemPrompt.placeholder': 'You are a WeChat auto-reply assistant...',
    'settings.testConnection': 'Test Connection',
    'settings.testConnection.testing': 'Testing...',
    'settings.testConnection.success': 'Connection OK',
    'settings.testConnection.fail': 'Connection Failed',
    'settings.save': 'Save',
    'settings.saved': 'Settings saved',

    'settings.general': 'General',
    'settings.language': 'Language',

    'diag.title': 'Diagnostics',
    'diag.lifecycle.title': 'Engine Lifecycle',
    'diag.lifecycle.state': 'Current State',
    'diag.lifecycle.enteredAt': 'Entered',
    'diag.lifecycle.restartBudget': 'Restart Budget',
    'diag.lifecycle.lastError': 'Last Error',
    'diag.lifecycle.windowEndsAt': 'Window ends',
    'diag.logs.title': 'Live Logs',
    'diag.logs.empty': 'No log records yet',
    'diag.logs.filterLevel': 'Level',
    'diag.logs.filterPhase': 'Phase',
    'diag.logs.filterAll': 'All',
    'diag.transitions.title': 'Recent Transitions',
    'diag.transitions.empty': 'No transitions yet',
    'diag.export': 'Export Bundle',
    'diag.export.success': 'Diagnostic bundle downloaded',
    'diag.errorBoundary.title': 'Renderer crashed',
    'diag.errorBoundary.hint':
      'Copy the error below and send it to the developer, or attach a diagnostic bundle to your issue',
    'diag.errorBoundary.copy': 'Copy error',
    'diag.errorBoundary.reload': 'Reload',

    'policy.title': 'Anti-detection',
    'policy.openSettings': 'Anti-detection →',
    'policy.tripped': 'Circuit breaker tripped',
    'policy.resetBreaker': 'Reset breaker',
    'policy.preset.label': 'Presets',
    'policy.preset.conservative': 'Conservative',
    'policy.preset.balanced': 'Balanced',
    'policy.preset.aggressive': 'Aggressive',
    'policy.section.humanizer': 'Humanizer',
    'policy.section.rateLimiter': 'Rate limiter',
    'policy.section.schedule': 'Schedule',
    'policy.section.breaker': 'Circuit breaker',
    'policy.field.enabled': 'Enabled',
    'policy.field.preActionDelayMs': 'Pre-action delay (ms)',
    'policy.field.postActionDelayMs': 'Post-action delay (ms)',
    'policy.field.clickJitterPx': 'Click jitter (px)',
    'policy.field.charsPerSecond': 'Typing speed (chars/sec)',
    'policy.field.punctuationPauseMs': 'Punctuation pause (ms)',
    'policy.field.typoProbability': 'Typo probability',
    'policy.field.longPauseProbability': 'Long-pause probability',
    'policy.field.longPauseMs': 'Long-pause (ms)',
    'policy.field.readDelayMs': 'Read delay (ms)',
    'policy.field.globalPerHour': 'Global per hour',
    'policy.field.perContactPerDay': 'Per contact per day',
    'policy.field.minIntervalMs': 'Min interval (ms)',
    'policy.field.newContactCooldownMs': 'New-contact cooldown (ms)',
    'policy.field.afkProbability': 'AFK probability',
    'policy.field.afkDurationMs': 'AFK duration (ms)',
    'policy.field.windows': 'Windows (JSON)',
    'policy.field.consecutiveAiFailures': 'Consecutive AI failures',
    'policy.field.consecutiveRpaFailures': 'Consecutive RPA failures',
    'policy.field.duplicateReplyCount': 'Duplicate reply count',
    'policy.field.screenshotFreezeMs': 'Screenshot freeze (ms)',
    'policy.field.bannedKeywords': 'Banned keywords (one per line)',
    'policy.range.to': 'to',
    'policy.invalidRange': 'Range lower bound must be ≤ upper',
    'policy.invalidWindowsJson': 'Invalid windows JSON',
    'policy.save': 'Save',
    'policy.reloadDefaults': 'Reload',
    'policy.saved': 'Anti-detection settings saved',
    'policy.saveFailed': 'Save failed',
    'policy.resetBreakerDone': 'Breaker reset',

    'toast.engineStarted': 'Engine started',
    'toast.engineStopped': 'Engine stopped',
    'toast.startFailed': 'Failed to start',
    'toast.copied': 'Copied to clipboard'
  }
} as const

export type TranslationKey = keyof (typeof translations)['zh']

let currentLocale: Locale = 'zh'

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function getLocale(): Locale {
  return currentLocale
}

export function t(key: TranslationKey): string {
  return translations[currentLocale]?.[key] || translations.zh[key] || key
}
