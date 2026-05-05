/**
 * Anti-detection policy configuration schemas.
 *
 * Validated end-to-end with zod so user-supplied JSON (from electron-store
 * or a future settings UI) parses into well-typed config or fails loudly
 * with a useful error path.
 *
 * Field names and defaults here are THE contract: humanizer/rate-limiter/
 * schedule/circuit-breaker modules consume them by reference.
 */

import { z } from 'zod'

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * `[min, max]` numeric range tuple with a default. Both bounds inclusive.
 * Refines that min ≤ max so downstream code can `random(min, max)` safely.
 *
 * Returns the schema as-default-typed so it composes cleanly inside z.object
 * without making the parent treat the field as required.
 */
function range(
  defaultValue: [number, number],
  opts: { min?: number } = {}
): z.ZodDefault<z.ZodEffects<z.ZodTuple<[z.ZodNumber, z.ZodNumber]>>> {
  const num = opts.min !== undefined ? z.number().min(opts.min) : z.number()
  const tuple = z.tuple([num, num])
  return tuple
    .refine((v) => v[0] <= v[1], { message: 'range[0] must be ≤ range[1]' })
    .default(defaultValue)
}

// ── Humanizer ──────────────────────────────────────────────────────────────

export const HumanizerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  preActionDelayMs: range([80, 220], { min: 0 }),
  postActionDelayMs: range([200, 500], { min: 0 }),
  clickJitterPx: z.number().min(0).default(2),
  charsPerSecond: range([4, 8], { min: 0.1 }),
  punctuationPauseMs: range([100, 300], { min: 0 }),
  typoProbability: z.number().min(0).max(1).default(0.02),
  longPauseProbability: z.number().min(0).max(1).default(0.05),
  longPauseMs: range([1500, 4000], { min: 0 }),
  readDelayMs: range([400, 1500], { min: 0 })
})
export type HumanizerConfig = z.infer<typeof HumanizerConfigSchema>

// ── RateLimiter ────────────────────────────────────────────────────────────

export const RateLimiterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  globalPerHour: z.number().int().min(0).default(30),
  perContactPerDay: z.number().int().min(0).default(20),
  minIntervalMs: z.number().int().min(0).default(8_000),
  newContactCooldownMs: z.number().int().min(0).default(60_000)
})
export type RateLimiterConfig = z.infer<typeof RateLimiterConfigSchema>

// ── Schedule ───────────────────────────────────────────────────────────────

/** "HH:MM" 24-hour time string (validated lazily in the schema). */
export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected "HH:MM" 24-hour time')

export const ScheduleConfigSchema = z.object({
  // Off by default — the engine's behaviour matches the pre-Phase-3 baseline
  // until the user opts in via settings.
  enabled: z.boolean().default(false),
  // weekday('0'..'6', 0=Sun) → array of inclusive [start, end] HH:MM windows.
  // Local time, no timezone bookkeeping.
  windows: z
    .record(
      z.string().regex(/^[0-6]$/, 'weekday key must be "0".."6"'),
      z.array(z.tuple([TimeOfDay, TimeOfDay]))
    )
    .default({}),
  afkProbability: z.number().min(0).max(1).default(0.05),
  afkDurationMs: range([30_000, 180_000], { min: 0 })
})
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

// ── CircuitBreaker ─────────────────────────────────────────────────────────

export const CircuitBreakerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  consecutiveAiFailures: z.number().int().min(1).default(5),
  consecutiveRpaFailures: z.number().int().min(1).default(3),
  duplicateReplyCount: z.number().int().min(2).default(3),
  screenshotFreezeMs: z.number().int().min(1_000).default(300_000),
  bannedKeywords: z.array(z.string()).default(['账号异常', '冻结', '违规'])
})
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>

// ── Top-level ──────────────────────────────────────────────────────────────

export const AntiDetectionConfigSchema = z.object({
  humanizer: HumanizerConfigSchema.default({}),
  rateLimiter: RateLimiterConfigSchema.default({}),
  schedule: ScheduleConfigSchema.default({}),
  circuitBreaker: CircuitBreakerConfigSchema.default({})
})
export type AntiDetectionConfig = z.infer<typeof AntiDetectionConfigSchema>

/**
 * Parse a partial / unknown blob into a fully-defaulted config. Throws
 * `ZodError` with a useful path on invalid input.
 */
export function parseAntiDetectionConfig(input: unknown): AntiDetectionConfig {
  return AntiDetectionConfigSchema.parse(input ?? {})
}

/**
 * Convenience: returns the all-default config without hitting the parser
 * twice (used by the engine startup path before electron-store is loaded).
 */
export function defaultAntiDetectionConfig(): AntiDetectionConfig {
  return AntiDetectionConfigSchema.parse({})
}
