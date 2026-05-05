/**
 * CircuitBreaker — observes engine/AI/RPA signals and trips into a tripped
 * state once a failure threshold is breached. Once tripped, the breaker is
 * sticky: it stays tripped until `reset()` is called. Counters keep updating
 * internally even while tripped so `snapshot()` remains useful for diagnostics.
 *
 * The breaker NEVER auto-resumes — by design. Recovery from a circuit-break
 * trip is the user's call (Phase 3 spec §3.2.4: "绝不自动重启").
 */

import { type CircuitBreakerConfig } from './config'
import { getLogger } from '../observability'

export type BreakerSignal =
  | { type: 'aiFailure'; err?: Error }
  | { type: 'aiSuccess' }
  | { type: 'rpaFailure'; err?: Error }
  | { type: 'rpaSuccess' }
  | { type: 'replyText'; text: string }
  | { type: 'screenshotHash'; hash: string }
  | { type: 'screenText'; text: string }

export type BreakerReason =
  | 'consecutiveAiFailures'
  | 'consecutiveRpaFailures'
  | 'duplicateReply'
  | 'screenshotFreeze'
  | 'bannedKeyword'

export type BreakerState =
  | { tripped: false }
  | { tripped: true; reason: BreakerReason; detail: string; at: number }

export interface BreakerSnapshot {
  state: BreakerState
  consecutiveAiFailures: number
  consecutiveRpaFailures: number
  recentReplyText: string[]
  lastScreenshotHash: string | null
  lastScreenshotChangeAt: number
}

export interface CircuitBreakerOptions {
  config: CircuitBreakerConfig
  now?: () => number
}

const log = getLogger('policy.circuit-breaker')

export class CircuitBreaker {
  private config: CircuitBreakerConfig
  private readonly nowFn: () => number

  private tripped: BreakerState = { tripped: false }
  private consecutiveAiFailures = 0
  private consecutiveRpaFailures = 0
  private recentReplyText: string[] = []
  private lastScreenshotHash: string | null = null
  private lastScreenshotChangeAt = 0

  constructor(opts: CircuitBreakerOptions) {
    this.config = opts.config
    this.nowFn = opts.now ?? ((): number => Date.now())
  }

  updateConfig(patch: Partial<CircuitBreakerConfig>): void {
    // Shallow merge. New thresholds apply to subsequent observe() calls; we do
    // not retroactively re-evaluate existing counters. (If counters already
    // exceed the new threshold, the next failure of that family will trip.)
    this.config = { ...this.config, ...patch }
  }

  observe(signal: BreakerSignal): void {
    if (!this.config.enabled) return

    switch (signal.type) {
      case 'aiSuccess':
        this.consecutiveAiFailures = 0
        return
      case 'aiFailure':
        this.consecutiveAiFailures++
        if (
          !this.tripped.tripped &&
          this.consecutiveAiFailures >= this.config.consecutiveAiFailures
        ) {
          this.trip(
            'consecutiveAiFailures',
            `${this.consecutiveAiFailures} consecutive AI failures`
          )
        }
        return
      case 'rpaSuccess':
        this.consecutiveRpaFailures = 0
        return
      case 'rpaFailure':
        this.consecutiveRpaFailures++
        if (
          !this.tripped.tripped &&
          this.consecutiveRpaFailures >= this.config.consecutiveRpaFailures
        ) {
          this.trip(
            'consecutiveRpaFailures',
            `${this.consecutiveRpaFailures} consecutive RPA failures`
          )
        }
        return
      case 'replyText': {
        // Cap the buffer at duplicateReplyCount * 2 (FIFO drop). The factor
        // of two is a margin so trip detection on the LAST N entries always
        // sees them even after one wrap.
        const cap = Math.max(2, this.config.duplicateReplyCount * 2)
        this.recentReplyText.push(signal.text)
        if (this.recentReplyText.length > cap) {
          this.recentReplyText = this.recentReplyText.slice(-cap)
        }
        if (this.tripped.tripped) return
        const last = this.recentReplyText.slice(-this.config.duplicateReplyCount)
        if (last.length === this.config.duplicateReplyCount && last.every((t) => t === last[0])) {
          const truncated = signal.text.length > 80 ? `${signal.text.slice(0, 80)}…` : signal.text
          this.trip('duplicateReply', `repeated: ${truncated}`)
        }
        return
      }
      case 'screenshotHash': {
        const now = this.nowFn()
        if (this.lastScreenshotHash === null) {
          // Initial observation; seed the watermark, never trip.
          this.lastScreenshotHash = signal.hash
          this.lastScreenshotChangeAt = now
          return
        }
        if (signal.hash !== this.lastScreenshotHash) {
          this.lastScreenshotHash = signal.hash
          this.lastScreenshotChangeAt = now
          return
        }
        // Same hash as before — check freeze duration.
        if (
          !this.tripped.tripped &&
          now - this.lastScreenshotChangeAt >= this.config.screenshotFreezeMs
        ) {
          this.trip(
            'screenshotFreeze',
            `screenshot unchanged for ${now - this.lastScreenshotChangeAt}ms`
          )
        }
        return
      }
      case 'screenText': {
        if (this.tripped.tripped) return
        if (this.config.bannedKeywords.length === 0) return
        for (const kw of this.config.bannedKeywords) {
          if (kw.length > 0 && signal.text.includes(kw)) {
            this.trip('bannedKeyword', `matched: ${kw}`)
            return
          }
        }
        return
      }
    }
  }

  state(): BreakerState {
    return this.tripped
  }

  reset(): void {
    log.info('CircuitBreaker reset', {
      wasTripped: this.tripped.tripped,
      reason: this.tripped.tripped ? this.tripped.reason : null
    })
    this.tripped = { tripped: false }
    this.consecutiveAiFailures = 0
    this.consecutiveRpaFailures = 0
    this.recentReplyText = []
    // Intentionally do NOT clear lastScreenshotHash / lastScreenshotChangeAt:
    // a brief reset shouldn't accidentally re-arm a freeze trip on the next
    // observation if the same screen is still showing.
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.tripped,
      consecutiveAiFailures: this.consecutiveAiFailures,
      consecutiveRpaFailures: this.consecutiveRpaFailures,
      recentReplyText: [...this.recentReplyText],
      lastScreenshotHash: this.lastScreenshotHash,
      lastScreenshotChangeAt: this.lastScreenshotChangeAt
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private trip(reason: BreakerReason, detail: string): void {
    const at = this.nowFn()
    this.tripped = { tripped: true, reason, detail, at }
    log.warn('CircuitBreaker tripped', { reason, detail, at })
  }
}
