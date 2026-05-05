/**
 * Schedule — anti-detection module that gates engine activity to user-configured
 * weekly time windows and occasionally injects "AFK" pauses.
 *
 * Pure / deterministic: all clock + RNG access is injected via `now` and
 * `random` callbacks so the unit tests can drive every branch with fixed
 * inputs. The module owns no timers and never reaches into electron.
 *
 * Cross-midnight window convention
 * --------------------------------
 * A window `[start, end]` with `start > end` (e.g. `["22:00", "02:00"]`)
 * "wraps" past midnight, but the wrap is interpreted as belonging entirely to
 * the SAME calendar day's weekday key — that weekday is awake from `start`
 * through 23:59 AND from 00:00 through `end`. The early-morning portion is NOT
 * inherited from the previous calendar day. This keeps the awake check a pure
 * function of (today's weekday key, today's HH:MM) without any look-back.
 *
 * Endpoint inclusivity
 * --------------------
 * A window `["09:00", "17:00"]` is awake at exactly 09:00 AND at exactly 17:00.
 * Both endpoints are inclusive.
 */

import { type ScheduleConfig } from './config'
import { getLogger, type Logger } from '../observability'

export type AwakeResult =
  | { awake: true }
  | { awake: false; nextAwakeAt: Date | null; reason: 'outOfWindow' | 'disabled' }

export type AfkResult = { afk: false } | { afk: true; durationMs: number }

export interface ScheduleOptions {
  config: ScheduleConfig
  now?: () => Date
  random?: () => number
}

type WeekdayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export class Schedule {
  private config: ScheduleConfig
  private readonly nowFn: () => Date
  private readonly randomFn: () => number
  private readonly logger: Logger
  private lastAwake: boolean | null = null

  constructor(opts: ScheduleOptions) {
    this.config = opts.config
    this.nowFn = opts.now ?? ((): Date => new Date())
    this.randomFn = opts.random ?? Math.random
    this.logger = getLogger('policy.schedule')
  }

  updateConfig(patch: Partial<ScheduleConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  isAwake(): AwakeResult {
    const result = this.computeAwake()
    this.logTransition(result.awake)
    return result
  }

  maybeAfk(): AfkResult {
    // No AFK simulation when scheduling is off — the engine simply runs.
    if (!this.config.enabled) return { afk: false }

    const roll = this.randomFn()
    if (roll >= this.config.afkProbability) return { afk: false }

    const [min, max] = this.config.afkDurationMs
    // Use a fresh draw for the duration so prob and length aren't correlated.
    const span = max - min + 1
    const dur = Math.floor(min + this.randomFn() * span)
    return { afk: true, durationMs: Math.min(dur, max) }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private computeAwake(): AwakeResult {
    // Phase 3: when scheduling is disabled the agent runs 24/7. The
    // `reason: 'disabled'` literal is reserved in the union for a future
    // user-pause API and is intentionally NEVER produced by today's code.
    if (!this.config.enabled) return { awake: true }

    const now = this.nowFn()
    const key = String(now.getDay()) as WeekdayKey
    const todayWindows = this.config.windows[key] ?? []
    const minutes = now.getHours() * 60 + now.getMinutes()

    for (const [start, end] of todayWindows) {
      if (matchesWindow(minutes, start, end)) {
        return { awake: true }
      }
    }

    return {
      awake: false,
      nextAwakeAt: this.computeNextAwakeAt(now),
      reason: 'outOfWindow'
    }
  }

  /**
   * Earliest future-or-equal window start across today and the next 7 calendar
   * days. Returns `null` if no configured window falls inside that horizon.
   */
  private computeNextAwakeAt(now: Date): Date | null {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    let best: Date | null = null

    for (let offset = 0; offset <= 7; offset++) {
      const day = new Date(today.getTime() + offset * MS_PER_DAY)
      const key = String(day.getDay()) as WeekdayKey
      const windows = this.config.windows[key] ?? []
      for (const [start] of windows) {
        const [h, m] = parseHHMM(start)
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0)
        if (candidate.getTime() < now.getTime()) continue
        if (best === null || candidate.getTime() < best.getTime()) {
          best = candidate
        }
      }
    }
    return best
  }

  private logTransition(currentAwake: boolean): void {
    if (this.lastAwake !== null && this.lastAwake !== currentAwake) {
      this.logger.info('awake-state-changed', {
        from: this.lastAwake,
        to: currentAwake
      })
    }
    this.lastAwake = currentAwake
  }
}

function parseHHMM(s: string): [number, number] {
  const [hStr, mStr] = s.split(':')
  return [Number(hStr), Number(mStr)]
}

function toMinutes(s: string): number {
  const [h, m] = parseHHMM(s)
  return h * 60 + m
}

function matchesWindow(minutes: number, start: string, end: string): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s <= e) {
    return minutes >= s && minutes <= e
  }
  // Cross-midnight wrap: awake from s..23:59 OR 00:00..e of the same day key.
  return minutes >= s || minutes <= e
}
