/**
 * Zod schemas for every IPC channel exposed by the main process.
 *
 * One source of truth for the shape of inbound IPC payloads. Every
 * `ipcMain.handle(channel, ...)` callback parses the raw renderer-supplied
 * argument through `parseIpc(SomeSchema, raw)` as its first step and rejects
 * malformed payloads with a structured `{ success: false, error }` (or the
 * channel's existing fallback) instead of crashing or trusting the type
 * annotation.
 *
 * Style follows `src/core/policy/config.ts`: defaults baked into the schema,
 * `z.infer` for the matching TS type, and `.passthrough()` only where the
 * channel intentionally accepts forward-compatible extra fields.
 */

import { z } from 'zod'

// ── Settings ──────────────────────────────────────────────────────────────

export const SettingsGetAllSchema = z.void()

export const SettingsGetSchema = z.string().min(1)

/**
 * `settings:set` is intentionally permissive: the runtime allowlist
 * (`WRITABLE_SETTING_KEYS` in `secure-store.ts`) is the security boundary, so
 * the schema's job here is only type-discipline — reject obvious nonsense
 * (a string instead of an object, an apiKey that's a number, …) while
 * letting forward-compatible fields pass through to the handler unchanged.
 */
export const SettingsSetSchema = z
  .object({
    apiKey: z.string().nullable().optional(),
    model: z.string().optional(),
    baseURL: z.string().optional(),
    systemPrompt: z.string().optional(),
    locale: z.string().optional(),
    appType: z.string().optional(),
    antiDetection: z.unknown().optional()
  })
  .passthrough()
export type SettingsSetPayload = z.infer<typeof SettingsSetSchema>

// ── Engine ────────────────────────────────────────────────────────────────

export const EngineStartSchema = z.object({
  apiKey: z.string(),
  model: z.string().optional(),
  baseURL: z.string().optional(),
  systemPrompt: z.string().optional(),
  appType: z.string().optional()
})
export type EngineStartPayload = z.infer<typeof EngineStartSchema>

export const EngineStopSchema = z.void()

export const EngineStatusSchema = z.void()

export const EngineUpdateConfigSchema = z.object({
  apiKey: z.string(),
  model: z.string().optional(),
  baseURL: z.string().optional(),
  systemPrompt: z.string().optional(),
  appType: z.string().optional()
})
export type EngineUpdateConfigPayload = z.infer<typeof EngineUpdateConfigSchema>

export const EngineTestConnectionSchema = z.object({
  apiKey: z.string(),
  model: z.string().optional(),
  baseURL: z.string().optional()
})
export type EngineTestConnectionPayload = z.infer<typeof EngineTestConnectionSchema>

export const EngineLifecycleSchema = z.void()

// ── Anti-detection policy ─────────────────────────────────────────────────

export const PolicyGetSchema = z.void()

/**
 * The `policy:set` handler already routes the payload through
 * `parseAntiDetectionConfig` for the real validation, so the IPC-layer schema
 * is a passthrough that only guarantees we got *something* across the bridge.
 */
export const PolicySetSchema = z.unknown()

export const PolicySnapshotSchema = z.void()

export const PolicyResetBreakerSchema = z.void()

// ── Logs / diagnostics / misc ─────────────────────────────────────────────

export const LogsRecentSchema = z.number().int().min(1).max(2000).optional().default(200)

export const CaptureScreenSchema = z.void()

export const TestVlmParallelSchema = z.void()

export const DiagExportSchema = z
  .object({
    includeLogs: z.boolean().optional().default(true),
    daysBack: z.number().int().min(1).max(365).optional().default(14)
  })
  .optional()
  .default({})
export type DiagExportPayload = z.infer<typeof DiagExportSchema>

// ── Helper ────────────────────────────────────────────────────────────────

export interface IpcParseSuccess<T> {
  ok: true
  value: T
}

export interface IpcParseFailure {
  ok: false
  error: string
}

export type IpcParseResult<T> = IpcParseSuccess<T> | IpcParseFailure

/**
 * Parse an IPC request payload against the given schema.
 *
 * On success returns `{ ok: true, value }` with the schema's parsed (and
 * possibly default-filled) output. On failure returns `{ ok: false, error }`
 * where `error` is a compact `field.path: message; …` string suitable for
 * surfacing to the renderer or logging. Raw input is *never* echoed back —
 * a malicious renderer can't use error messages as a side channel.
 *
 * Callers are expected to log the rejection with their own logger so the
 * channel name is captured in the structured record; this helper stays
 * pure to remain trivially unit-testable.
 */
export function parseIpc<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown
): IpcParseResult<z.infer<T>> {
  const result = schema.safeParse(raw)
  if (result.success) {
    return { ok: true, value: result.data as z.infer<T> }
  }
  const issues = result.error.errors.map(
    (e) => `${e.path.length > 0 ? e.path.join('.') : '<root>'}: ${e.message}`
  )
  return { ok: false, error: issues.join('; ') }
}
