import type { LogRecord, LogSink } from '../types'

export interface RingBufferSinkOpts {
  size: number
}

export class RingBufferSink implements LogSink {
  private buffer: LogRecord[]
  private capacity: number
  private head: number
  private count: number
  private totalWritten: number

  constructor(opts?: RingBufferSinkOpts) {
    this.capacity = opts?.size ?? 1000
    this.buffer = new Array<LogRecord>(this.capacity)
    this.head = 0
    this.count = 0
    this.totalWritten = 0
  }

  write(r: LogRecord): void {
    this.buffer[this.head] = r
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) {
      this.count++
    }
    this.totalWritten++
  }

  getAll(): LogRecord[] {
    if (this.count === 0) return []

    const result: LogRecord[] = []
    if (this.count < this.capacity) {
      // Buffer not yet full: records start at index 0
      for (let i = 0; i < this.count; i++) {
        result.push(this.buffer[i])
      }
    } else {
      // Buffer is full: oldest record is at head
      for (let i = 0; i < this.capacity; i++) {
        result.push(this.buffer[(this.head + i) % this.capacity])
      }
    }
    return result
  }

  drainSince(idx: number): { records: LogRecord[]; nextIdx: number } {
    const oldestIdx = Math.max(0, this.totalWritten - this.count)
    const fromIdx = Math.max(idx, oldestIdx)
    const records: LogRecord[] = []

    for (let i = fromIdx; i < this.totalWritten; i++) {
      const bufPos = i % this.capacity
      records.push(this.buffer[bufPos])
    }

    return { records, nextIdx: this.totalWritten }
  }

  clear(): void {
    this.buffer = new Array<LogRecord>(this.capacity)
    this.head = 0
    this.count = 0
    this.totalWritten = 0
  }
}
