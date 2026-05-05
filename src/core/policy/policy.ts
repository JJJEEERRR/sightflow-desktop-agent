/**
 * AntiDetectionPolicy — combines Humanizer / RateLimiter / Schedule /
 * CircuitBreaker into the three-hook surface the engine consumes:
 *
 *   beforeReply  — run BEFORE every screenshot/decide tick. Decides whether
 *                  the engine is allowed to proceed and applies the
 *                  natural-feeling delays (read delay, AFK, long pauses).
 *   beforeAction — run BEFORE each device action (click / sendMessage). Wraps
 *                  in pre-action delay and applies coord jitter.
 *   afterAction  — run AFTER each device action. Records the send into the
 *                  rate-limiter (on a successful 'reply'), forwards the RPA
 *                  outcome into the breaker, and applies the post-action
 *                  delay so subsequent operations look paced.
 *
 * Plus `observe(signal)` which forwards arbitrary signals (AI ok/fail,
 * replyText, screenText) to the breaker.
 *
 * Key invariants (tested):
 *  - beforeReply checks the breaker FIRST. A tripped breaker always returns
 *    proceed:false with a pause directive.
 *  - schedule out-of-window does NOT pause the lifecycle — engine just
 *    waitMs and re-checks. (Spec: only the breaker is allowed to demand
 *    human-in-the-loop.)
 *  - rate-limiter retryAfterMs is reflected verbatim in waitMs; engine
 *    sleeps and retries.
 *  - All clocks/RNG must flow through the underlying modules, not Date.now
 *    directly.
 */

import { Humanizer, type HumanizerClock } from './humanizer'
import { RateLimiter, type KvStorage } from './rate-limiter'
import { Schedule } from './schedule'
import { CircuitBreaker, type BreakerSignal } from './circuit-breaker'
import {
  parseAntiDetectionConfig,
  defaultAntiDetectionConfig,
  type AntiDetectionConfig
} from './config'
import { getLogger } from '../observability'
import type { PauseReason } from '../runtime/types'

const log = getLogger('policy')

export type ActionDescriptor =
  | { type: 'click'; coords: [number, number] }
  | { type: 'reply'; text: string; contactId?: string }
  | { type: 'send'; contactId?: string }

export interface BeforeReplyContext {
  contactId?: string
}

export type BeforeReplyResult =
  | { proceed: true }
  | {
      proceed: false
      reason: string
      // How long the engine should sleep before its next attempt.
      waitMs: number
      // When set, the engine should additionally pause the lifecycle (and not
      // auto-resume). Used exclusively for the circuit breaker tripping;
      // schedule and rate-limiter use plain waitMs.
      pause?: { reason: PauseReason; detail: string }
    }

export interface BeforeActionResult {
  // For click actions, the (possibly-jittered) coordinates. Engine uses these
  // verbatim. For non-click actions this is undefined.
  jitteredCoords?: [number, number]
}

export interface PolicySnapshot {
  config: AntiDetectionConfig
  rateLimiter: ReturnType<RateLimiter['snapshot']>
  schedule: { awake: boolean; reason?: string; nextAwakeAt: string | null }
  circuitBreaker: ReturnType<CircuitBreaker['snapshot']>
}

export interface AntiDetectionPolicyOptions {
  config?: Partial<AntiDetectionConfig> | AntiDetectionConfig
  storage: KvStorage
  // Optional fakes for tests.
  humanizerClock?: HumanizerClock
  now?: () => number
  nowDate?: () => Date
  random?: () => number
}

export class AntiDetectionPolicy {
  private config: AntiDetectionConfig
  private readonly humanizer: Humanizer
  private readonly rateLimiter: RateLimiter
  private readonly schedule: Schedule
  private readonly breaker: CircuitBreaker
  private readonly humanizerClock?: HumanizerClock

  constructor(opts: AntiDetectionPolicyOptions) {
    this.config = parseAntiDetectionConfig(opts.config ?? {})
    this.humanizerClock = opts.humanizerClock

    this.humanizer = new Humanizer({
      config: this.config.humanizer,
      clock: this.humanizerClock
    })
    this.rateLimiter = new RateLimiter({
      config: this.config.rateLimiter,
      storage: opts.storage,
      now: opts.now
    })
    this.schedule = new Schedule({
      config: this.config.schedule,
      now: opts.nowDate,
      random: opts.random
    })
    this.breaker = new CircuitBreaker({
      config: this.config.circuitBreaker,
      now: opts.now
    })
  }

  /**
   * Replace the running config. Sub-modules are updated in place; existing
   * persisted state (rate-limiter counters, breaker counters) is preserved.
   * Throws if the patch fails zod validation when merged with the current
   * config.
   */
  updateConfig(patch: Partial<AntiDetectionConfig>): void {
    const merged = parseAntiDetectionConfig({ ...this.config, ...patch })
    this.config = merged
    this.humanizer.updateConfig(merged.humanizer)
    this.rateLimiter.updateConfig(merged.rateLimiter)
    this.schedule.updateConfig(merged.schedule)
    this.breaker.updateConfig(merged.circuitBreaker)
  }

  getConfig(): AntiDetectionConfig {
    return this.config
  }

  /**
   * Engine calls this at the top of every tick. Returns proceed:true once
   * all gates pass and any read/AFK/long-pause delays have been awaited.
   */
  async beforeReply(ctx: BeforeReplyContext = {}): Promise<BeforeReplyResult> {
    // 1. Circuit breaker. Sticky once tripped — only the user can clear it.
    const bs = this.breaker.state()
    if (bs.tripped) {
      log.warn('beforeReply blocked: breaker tripped', {
        reason: bs.reason,
        detail: bs.detail
      })
      return {
        proceed: false,
        reason: `breaker:${bs.reason}`,
        waitMs: 0,
        pause: { reason: 'breaker', detail: `${bs.reason}: ${bs.detail}` }
      }
    }

    // 2. Schedule window. Out-of-window = engine sleeps, no lifecycle pause.
    const sw = this.schedule.isAwake()
    if (!sw.awake) {
      const waitMs = sw.nextAwakeAt
        ? // Cap waits at 5 minutes so a config change / manual stop is observable.
          Math.min(Math.max(0, sw.nextAwakeAt.getTime() - Date.now()), 5 * 60 * 1000)
        : 5 * 60 * 1000
      return {
        proceed: false,
        reason: `schedule:${sw.reason}`,
        waitMs
      }
    }

    // 3. Rate limiter (global + min-interval; per-contact only when ctx provides id).
    const rl = this.rateLimiter.check(ctx.contactId)
    if (!rl.allowed) {
      log.debug('beforeReply blocked: rate limit', { reason: rl.reason })
      return {
        proceed: false,
        reason: `rateLimit:${rl.reason}`,
        waitMs: rl.retryAfterMs
      }
    }

    // 4. Natural delays. We're allowed to send — apply pacing.
    await this.humanizer.readDelay()
    const afk = this.schedule.maybeAfk()
    if (afk.afk) {
      log.debug('beforeReply: AFK pause', { durationMs: afk.durationMs })
      await this.sleep(afk.durationMs)
    }
    await this.humanizer.maybeLongPause()

    return { proceed: true }
  }

  /**
   * Wraps a device action in pre-action humanizer delay + coord jitter. Engine
   * should use the returned `jitteredCoords` (when present) instead of the
   * original coordinates.
   */
  async beforeAction(action: ActionDescriptor): Promise<BeforeActionResult> {
    await this.humanizer.preActionDelay()
    if (action.type === 'click') {
      const [x, y] = action.coords
      const jittered = this.humanizer.jitterCoords(x, y)
      return { jitteredCoords: jittered }
    }
    return {}
  }

  /**
   * Wraps a device action with post-action delay, breaker observation, and
   * (on a successful 'reply' or 'send') rate-limiter accounting.
   */
  async afterAction(
    action: ActionDescriptor,
    outcome: { success: boolean; err?: Error }
  ): Promise<void> {
    if (outcome.success) {
      this.breaker.observe({ type: 'rpaSuccess' })
      if (action.type === 'reply' || action.type === 'send') {
        this.rateLimiter.recordSend(action.contactId)
        if (action.type === 'reply') {
          this.breaker.observe({ type: 'replyText', text: action.text })
        }
      }
    } else {
      this.breaker.observe({ type: 'rpaFailure', err: outcome.err })
    }
    await this.humanizer.postActionDelay()
  }

  /**
   * Forward a signal to the circuit breaker. The engine uses this for AI
   * success/failure and for any external observations (e.g. screenText on
   * banned-keyword scan once OCR lands).
   */
  observe(signal: BreakerSignal): void {
    this.breaker.observe(signal)
  }

  /**
   * After a user resume from a circuit-break pause, the engine should call
   * this so subsequent ticks can run again.
   */
  resetBreaker(): void {
    this.breaker.reset()
  }

  snapshot(): PolicySnapshot {
    const sw = this.schedule.isAwake()
    return {
      config: this.config,
      rateLimiter: this.rateLimiter.snapshot(),
      schedule: {
        awake: sw.awake,
        reason: sw.awake ? undefined : sw.reason,
        nextAwakeAt: sw.awake ? null : (sw.nextAwakeAt?.toISOString() ?? null)
      },
      circuitBreaker: this.breaker.snapshot()
    }
  }

  /** Convenience for callers (renderer) that just want the schema-defaulted blob. */
  static defaultConfig(): AntiDetectionConfig {
    return defaultAntiDetectionConfig()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    if (this.humanizerClock) return this.humanizerClock.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
