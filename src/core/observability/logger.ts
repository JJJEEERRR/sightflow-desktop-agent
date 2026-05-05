import { redact } from './redact'
import type { LogLevel, LogRecord, LogSink, Logger } from './types'

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
}

interface LoggerState {
  sinks: LogSink[]
  minLevel: LogLevel
}

const state: LoggerState = {
  sinks: [],
  minLevel: 'info'
}

export interface ConfigureLoggerOpts {
  env: 'dev' | 'prod'
  sinks: LogSink[]
  minLevel?: LogLevel
}

export function configureLogger(opts: ConfigureLoggerOpts): void {
  state.sinks = opts.sinks
  state.minLevel = opts.minLevel ?? (opts.env === 'dev' ? 'debug' : 'info')
}

/** @internal Test-only: resets module-level state between tests. */
export function resetLoggerForTests(): void {
  state.sinks = []
  state.minLevel = 'info'
}

function isError(value: unknown): value is Error {
  return value instanceof Error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  )
}

function buildErrField(err: Error): { name: string; message: string; stack?: string } {
  return {
    name: err.name,
    message: err.message,
    stack: err.stack
  }
}

function fanOut(record: LogRecord): void {
  for (const sink of state.sinks) {
    try {
      sink.write(record)
    } catch (err) {
      console.error('[Logger] Sink threw during write:', err)
    }
  }
}

class LoggerImpl implements Logger {
  private phase: string
  private traceId: string | undefined

  constructor(phase: string, traceId?: string) {
    this.phase = phase
    this.traceId = traceId
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[state.minLevel]
  }

  private writeRecord(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
    err?: { name: string; message: string; stack?: string }
  ): void {
    if (!this.shouldLog(level)) return

    const redactedData = data !== undefined ? (redact(data) as Record<string, unknown>) : undefined

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      phase: this.phase,
      msg
    }
    if (this.traceId !== undefined) {
      record.traceId = this.traceId
    }
    if (redactedData !== undefined) {
      record.data = redactedData
    }
    if (err !== undefined) {
      record.err = err
    }

    fanOut(record)
  }

  trace(msg: string, data?: Record<string, unknown>): void {
    this.writeRecord('trace', msg, data)
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.writeRecord('debug', msg, data)
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.writeRecord('info', msg, data)
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.writeRecord('warn', msg, data)
  }

  error(msg: string, errOrData?: unknown): void {
    if (errOrData === undefined) {
      this.writeRecord('error', msg)
      return
    }

    if (isError(errOrData)) {
      this.writeRecord('error', msg, undefined, buildErrField(errOrData))
      return
    }

    if (isRecord(errOrData)) {
      // Check for { err: Error, ...rest } shape
      const { err: errField, ...rest } = errOrData
      if (isError(errField)) {
        const dataPayload = Object.keys(rest).length > 0 ? rest : undefined
        this.writeRecord('error', msg, dataPayload, buildErrField(errField))
        return
      }
      // Pure data object
      this.writeRecord('error', msg, errOrData)
      return
    }

    // Unrecognized type — treat as stringified data
    this.writeRecord('error', msg, { value: String(errOrData) })
  }

  child(phase: string, traceId?: string): Logger {
    return new LoggerImpl(`${this.phase}.${phase}`, traceId ?? this.traceId)
  }
}

export function getLogger(phase: string, traceId?: string): Logger {
  return new LoggerImpl(phase, traceId)
}
