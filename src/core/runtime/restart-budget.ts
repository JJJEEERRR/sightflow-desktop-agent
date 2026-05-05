export interface RestartBudgetOptions {
  max: number
  windowMs: number
  now?: () => number
}

export class RestartBudget {
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number
  private timestamps: number[]

  constructor(opts: RestartBudgetOptions) {
    this.max = opts.max
    this.windowMs = opts.windowMs
    this.now = opts.now ?? ((): number => Date.now())
    this.timestamps = []
  }

  /**
   * Try to consume a slot. Returns true if allowed, false if budget exhausted.
   * Implements a sliding window: drops timestamps older than now()-windowMs before checking.
   */
  recordAndCheck(): boolean {
    const current = this.now()
    this.timestamps = this.timestamps.filter((ts) => ts > current - this.windowMs)
    if (this.timestamps.length >= this.max) {
      return false
    }
    this.timestamps.push(current)
    return true
  }

  /** How many slots have been used in the current window. */
  used(): number {
    const current = this.now()
    this.timestamps = this.timestamps.filter((ts) => ts > current - this.windowMs)
    return this.timestamps.length
  }

  /** Timestamp (ISO 8601) when the current window ends. */
  windowEndsAt(): string {
    const current = this.now()
    const active = this.timestamps.filter((ts) => ts > current - this.windowMs)
    if (active.length === 0) {
      return new Date(current + this.windowMs).toISOString()
    }
    const oldest = Math.min(...active)
    return new Date(oldest + this.windowMs).toISOString()
  }

  /** Reset all recorded timestamps. */
  reset(): void {
    this.timestamps = []
  }
}
