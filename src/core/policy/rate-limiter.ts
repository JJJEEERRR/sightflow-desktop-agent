/**
 * RateLimiter — Phase 3 anti-detection policy gate.
 *
 * Enforces four independent throttles before a send is allowed:
 *   1. minInterval         — a minimum gap between any two sends
 *   2. globalPerHour       — total sends inside a fixed 1-hour window
 *   3. newContactCooldown  — extra cooldown when starting a brand-new contact
 *   4. perContactPerDay    — total sends to the same contact inside 24h
 *
 * State is persisted via an injected `KvStorage` (in production, electron-store)
 * so counts survive process restarts. `check()` is read-only; `recordSend()`
 * is the only entry point that mutates and persists state.
 *
 * Time is fully injectable (`now()`); we never call `Date.now()` directly so
 * tests can drive the limiter deterministically with a virtual clock.
 *
 * Edge cases: a config value of `0` for `globalPerHour`, `perContactPerDay`,
 * `minIntervalMs`, or `newContactCooldownMs` means "no limit / no cooldown" —
 * the corresponding gate is skipped entirely.
 */

import { type RateLimiterConfig } from './config'
import { getLogger, type Logger } from '../observability'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

const HOURLY_KEY = 'policy.rateLimiter.hourly'
const PER_CONTACT_KEY = 'policy.rateLimiter.perContact'
const LAST_SEND_KEY = 'policy.rateLimiter.lastSendAt'

export interface KvStorage {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
}

export type RateLimitReason =
  | 'globalPerHour'
  | 'perContactPerDay'
  | 'minInterval'
  | 'newContactCooldown'

export type CheckResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; reason: RateLimitReason }

export interface RateLimiterSnapshot {
  hourly: { used: number; max: number; resetAt: number }
  perContact: Record<string, { used: number; max: number; resetAt: number }>
  lastSendAt: number
}

export interface RateLimiterOptions {
  config: RateLimiterConfig
  storage: KvStorage
  now?: () => number
}

interface HourlyState {
  count: number
  windowStartedAt: number
}

interface PerContactEntry {
  count: number
  windowStartedAt: number
  firstSeenAt: number
}

export class RateLimiter {
  private config: RateLimiterConfig
  private readonly storage: KvStorage
  private readonly now: () => number
  private readonly log: Logger
  private hourly: HourlyState
  private perContact: Record<string, PerContactEntry>
  private lastSendAt: number

  constructor(opts: RateLimiterOptions) {
    this.config = opts.config
    this.storage = opts.storage
    this.now = opts.now ?? ((): number => Date.now())
    this.log = getLogger('policy.rate-limiter')
    this.hourly = readHourly(this.storage)
    this.perContact = readPerContact(this.storage)
    this.lastSendAt = readLastSendAt(this.storage)
  }

  updateConfig(patch: Partial<RateLimiterConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  check(contactId?: string): CheckResult {
    if (this.config.enabled === false) {
      return { allowed: true }
    }
    const now = this.now()

    // Gate 1 — minInterval (only meaningful once we've actually sent at least once)
    if (this.config.minIntervalMs > 0 && this.lastSendAt > 0) {
      const dt = now - this.lastSendAt
      if (dt < this.config.minIntervalMs) {
        const retryAfterMs = this.config.minIntervalMs - dt
        this.log.debug('gate tripped: minInterval', { retryAfterMs })
        return { allowed: false, reason: 'minInterval', retryAfterMs }
      }
    }

    // Gate 2 — globalPerHour (0 = unlimited)
    if (this.config.globalPerHour > 0) {
      const eff = effectiveHourly(this.hourly, now)
      if (eff.count >= this.config.globalPerHour) {
        const retryAfterMs = eff.windowStartedAt + HOUR_MS - now
        this.log.debug('gate tripped: globalPerHour', { retryAfterMs })
        return { allowed: false, reason: 'globalPerHour', retryAfterMs }
      }
    }

    // Gate 3 — newContactCooldown: only fires for a contact we have NEVER
    // sent to before, and only when we sent to *someone* recently enough.
    if (
      contactId !== undefined &&
      this.perContact[contactId] === undefined &&
      this.lastSendAt > 0 &&
      this.config.newContactCooldownMs > 0
    ) {
      const dt = now - this.lastSendAt
      if (dt < this.config.newContactCooldownMs) {
        const retryAfterMs = this.config.newContactCooldownMs - dt
        this.log.debug('gate tripped: newContactCooldown', { retryAfterMs })
        return { allowed: false, reason: 'newContactCooldown', retryAfterMs }
      }
    }

    // Gate 4 — perContactPerDay (0 = unlimited)
    if (contactId !== undefined && this.config.perContactPerDay > 0) {
      const existing = this.perContact[contactId]
      if (existing !== undefined) {
        const eff = effectivePerContact(existing, now)
        if (eff.count >= this.config.perContactPerDay) {
          const retryAfterMs = eff.windowStartedAt + DAY_MS - now
          this.log.debug('gate tripped: perContactPerDay', { retryAfterMs })
          return { allowed: false, reason: 'perContactPerDay', retryAfterMs }
        }
      }
    }

    return { allowed: true }
  }

  recordSend(contactId?: string): void {
    if (this.config.enabled === false) {
      return
    }
    const now = this.now()
    this.lastSendAt = now

    const rolledHourly = effectiveHourly(this.hourly, now)
    this.hourly = {
      count: rolledHourly.count + 1,
      windowStartedAt: rolledHourly.windowStartedAt
    }

    if (contactId !== undefined) {
      const prior = this.perContact[contactId]
      if (prior === undefined) {
        this.perContact[contactId] = {
          count: 1,
          windowStartedAt: now,
          firstSeenAt: now
        }
      } else {
        const rolled = effectivePerContact(prior, now)
        this.perContact[contactId] = {
          count: rolled.count + 1,
          windowStartedAt: rolled.windowStartedAt,
          firstSeenAt: prior.firstSeenAt
        }
      }
    }

    this.persist()
  }

  snapshot(): RateLimiterSnapshot {
    const now = this.now()
    const hourly = effectiveHourly(this.hourly, now)
    const perContact: Record<string, { used: number; max: number; resetAt: number }> = {}
    for (const [id, entry] of Object.entries(this.perContact)) {
      const eff = effectivePerContact(entry, now)
      perContact[id] = {
        used: eff.count,
        max: this.config.perContactPerDay,
        resetAt: eff.windowStartedAt + DAY_MS
      }
    }
    return {
      hourly: {
        used: hourly.count,
        max: this.config.globalPerHour,
        resetAt: hourly.windowStartedAt + HOUR_MS
      },
      perContact,
      lastSendAt: this.lastSendAt
    }
  }

  private persist(): void {
    this.storage.set(HOURLY_KEY, this.hourly)
    this.storage.set(PER_CONTACT_KEY, this.perContact)
    this.storage.set(LAST_SEND_KEY, this.lastSendAt)
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function effectiveHourly(s: HourlyState, now: number): HourlyState {
  if (s.windowStartedAt === 0 || now - s.windowStartedAt >= HOUR_MS) {
    return { count: 0, windowStartedAt: now }
  }
  return s
}

function effectivePerContact(s: PerContactEntry, now: number): PerContactEntry {
  if (s.windowStartedAt === 0 || now - s.windowStartedAt >= DAY_MS) {
    return { count: 0, windowStartedAt: now, firstSeenAt: s.firstSeenAt }
  }
  return s
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function readHourly(storage: KvStorage): HourlyState {
  const raw = storage.get(HOURLY_KEY)
  if (isObject(raw) && typeof raw.count === 'number' && typeof raw.windowStartedAt === 'number') {
    return { count: raw.count, windowStartedAt: raw.windowStartedAt }
  }
  return { count: 0, windowStartedAt: 0 }
}

function readPerContact(storage: KvStorage): Record<string, PerContactEntry> {
  const raw = storage.get(PER_CONTACT_KEY)
  if (!isObject(raw)) {
    return {}
  }
  const out: Record<string, PerContactEntry> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (
      isObject(value) &&
      typeof value.count === 'number' &&
      typeof value.windowStartedAt === 'number' &&
      typeof value.firstSeenAt === 'number'
    ) {
      out[id] = {
        count: value.count,
        windowStartedAt: value.windowStartedAt,
        firstSeenAt: value.firstSeenAt
      }
    }
  }
  return out
}

function readLastSendAt(storage: KvStorage): number {
  const raw = storage.get(LAST_SEND_KEY)
  return typeof raw === 'number' ? raw : 0
}
