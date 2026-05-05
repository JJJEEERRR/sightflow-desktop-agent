import type { LogRecord, LogSink } from '../types'

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
} as const

function levelColor(level: LogRecord['level']): string {
  switch (level) {
    case 'trace':
      return ANSI.cyan
    case 'debug':
      return ANSI.gray
    case 'info':
      return ANSI.white
    case 'warn':
      return ANSI.yellow
    case 'error':
      return ANSI.red
  }
}

export interface ConsoleSinkOpts {
  colorize: boolean
}

export class ConsoleSink implements LogSink {
  private opts: ConsoleSinkOpts

  constructor(opts: ConsoleSinkOpts) {
    this.opts = opts
  }

  write(r: LogRecord): void {
    const traceStr = r.traceId ? `[${r.traceId}]` : ''
    const dataStr = r.data && Object.keys(r.data).length > 0 ? ' ' + JSON.stringify(r.data) : ''
    const levelStr = r.level.toUpperCase().padEnd(5)

    let line = `[${r.ts}] ${levelStr} ${r.phase}${traceStr}: ${r.msg}${dataStr}`

    if (this.opts.colorize) {
      const color = levelColor(r.level)
      line = `${color}${line}${ANSI.reset}`
    }

    if (r.level === 'error') {
      if (r.err?.stack) {
        line += `\n${r.err.stack}`
      }
      console.error(line)
    } else if (r.level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }
}
