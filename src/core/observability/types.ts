export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string
  level: LogLevel
  phase: string
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

export interface HistogramSnapshot {
  count: number
  sum: number
  min: number
  max: number
  p50: number
  p95: number
}

export interface MetricsSnapshot {
  counters: Record<string, number>
  histograms: Record<string, HistogramSnapshot>
  takenAt: string
}

export interface TraceContext {
  traceId: string
  parentSpanId?: string
  spanId: string
  startedAt: number
}
