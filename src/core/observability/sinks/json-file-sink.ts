import fs from 'fs'
import path from 'path'
import type { LogRecord, LogSink } from '../types'

export interface JsonFileSinkOpts {
  dir: string
  dailyRotation: boolean
  maxDays?: number
}

function dateSuffix(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export class JsonFileSink implements LogSink {
  private dir: string
  private dailyRotation: boolean
  private maxDays: number
  private currentDay: string
  private dirEnsured: boolean

  constructor(opts: JsonFileSinkOpts) {
    this.dir = opts.dir
    this.dailyRotation = opts.dailyRotation
    this.maxDays = opts.maxDays ?? 30
    this.currentDay = ''
    this.dirEnsured = false
  }

  private ensureDir(): void {
    if (!this.dirEnsured) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
      } catch (err) {
        console.error('[JsonFileSink] Failed to create log directory:', err)
      }
      this.dirEnsured = true
    }
  }

  private currentFilePath(): string {
    const day = this.dailyRotation ? dateSuffix(new Date()) : 'current'
    return path.join(this.dir, `sightflow-${day}.jsonl`)
  }

  private pruneOldFiles(): void {
    try {
      const files = fs.readdirSync(this.dir)
      const cutoff = new Date()
      cutoff.setUTCDate(cutoff.getUTCDate() - this.maxDays)

      for (const file of files) {
        const match = /^sightflow-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)
        if (!match) continue
        const fileDate = new Date(match[1] + 'T00:00:00Z')
        if (fileDate < cutoff) {
          try {
            fs.unlinkSync(path.join(this.dir, file))
          } catch (err) {
            console.error('[JsonFileSink] Failed to prune old log file:', err)
          }
        }
      }
    } catch (err) {
      console.error('[JsonFileSink] Failed to read log directory for pruning:', err)
    }
  }

  write(r: LogRecord): void {
    this.ensureDir()

    const today = this.dailyRotation ? dateSuffix(new Date()) : 'current'
    if (today !== this.currentDay) {
      this.pruneOldFiles()
      this.currentDay = today
    }

    const filePath = this.currentFilePath()
    try {
      fs.appendFileSync(filePath, JSON.stringify(r) + '\n', 'utf8')
    } catch (err) {
      console.error('[JsonFileSink] Failed to write log record:', err)
    }
  }

  async flush(): Promise<void> {
    // Sync writes — nothing to flush
  }
}
