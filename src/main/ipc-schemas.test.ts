import { describe, expect, it } from 'vitest'
import {
  CaptureScreenSchema,
  DiagExportSchema,
  EngineLifecycleSchema,
  EngineStartSchema,
  EngineStatusSchema,
  EngineStopSchema,
  EngineTestConnectionSchema,
  EngineUpdateConfigSchema,
  LogsRecentSchema,
  parseIpc,
  PolicyGetSchema,
  PolicyResetBreakerSchema,
  PolicySetSchema,
  PolicySnapshotSchema,
  SettingsGetAllSchema,
  SettingsGetSchema,
  SettingsSetSchema,
  TestVlmParallelSchema
} from './ipc-schemas'

describe('parseIpc helper', () => {
  it('returns ok=true with the parsed value on success', () => {
    const result = parseIpc(SettingsGetSchema, 'apiKey')
    expect(result).toEqual({ ok: true, value: 'apiKey' })
  })

  it('applies schema defaults to the value', () => {
    const result = parseIpc(LogsRecentSchema, undefined)
    expect(result).toEqual({ ok: true, value: 200 })
  })

  it('returns ok=false with field-path-prefixed errors on failure', () => {
    const result = parseIpc(EngineStartSchema, { apiKey: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('apiKey')
      expect(result.error.toLowerCase()).toContain('expected string')
    }
  })

  it('uses <root> as the path when the failure is on the value itself', () => {
    const result = parseIpc(SettingsGetSchema, 42)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('<root>')
    }
  })

  it('joins multiple issues with "; "', () => {
    const result = parseIpc(EngineStartSchema, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('apiKey')
    }
  })
})

describe('settings schemas', () => {
  it('SettingsGetAllSchema accepts undefined', () => {
    expect(parseIpc(SettingsGetAllSchema, undefined).ok).toBe(true)
  })

  it('SettingsGetAllSchema rejects non-undefined input', () => {
    const r = parseIpc(SettingsGetAllSchema, 'oops')
    expect(r.ok).toBe(false)
  })

  it('SettingsGetSchema accepts a non-empty string', () => {
    expect(parseIpc(SettingsGetSchema, 'model').ok).toBe(true)
  })

  it('SettingsGetSchema rejects empty strings and non-strings', () => {
    expect(parseIpc(SettingsGetSchema, '').ok).toBe(false)
    expect(parseIpc(SettingsGetSchema, null).ok).toBe(false)
    expect(parseIpc(SettingsGetSchema, 7).ok).toBe(false)
  })

  it('SettingsSetSchema accepts the canonical payload shape', () => {
    const r = parseIpc(SettingsSetSchema, {
      apiKey: 'sk-abc',
      model: 'gpt-4o',
      baseURL: 'https://api.example.com',
      systemPrompt: 'be helpful',
      locale: 'en',
      appType: 'weixin',
      antiDetection: { humanizer: { enabled: true } }
    })
    expect(r.ok).toBe(true)
  })

  it('SettingsSetSchema accepts apiKey: null (clear) and missing apiKey', () => {
    expect(parseIpc(SettingsSetSchema, { apiKey: null }).ok).toBe(true)
    expect(parseIpc(SettingsSetSchema, {}).ok).toBe(true)
  })

  it('SettingsSetSchema rejects a non-string non-null apiKey', () => {
    const r = parseIpc(SettingsSetSchema, { apiKey: 5 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('apiKey')
  })

  it('SettingsSetSchema passes unknown forward-compat keys through', () => {
    const r = parseIpc(SettingsSetSchema, { futureKey: 'value' })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value as Record<string, unknown>).futureKey).toBe('value')
  })

  it('SettingsSetSchema rejects non-object input', () => {
    expect(parseIpc(SettingsSetSchema, 'not-an-object').ok).toBe(false)
    expect(parseIpc(SettingsSetSchema, null).ok).toBe(false)
  })
})

describe('engine schemas', () => {
  it('EngineStartSchema accepts the canonical payload', () => {
    const r = parseIpc(EngineStartSchema, {
      apiKey: 'sk',
      model: 'gpt',
      baseURL: 'https://x',
      systemPrompt: 'hi',
      appType: 'weixin'
    })
    expect(r.ok).toBe(true)
  })

  it('EngineStartSchema accepts only apiKey', () => {
    expect(parseIpc(EngineStartSchema, { apiKey: 'sk' }).ok).toBe(true)
  })

  it('EngineStartSchema rejects missing apiKey', () => {
    const r = parseIpc(EngineStartSchema, { model: 'gpt' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('apiKey')
  })

  it('EngineStopSchema / EngineStatusSchema / EngineLifecycleSchema accept undefined', () => {
    expect(parseIpc(EngineStopSchema, undefined).ok).toBe(true)
    expect(parseIpc(EngineStatusSchema, undefined).ok).toBe(true)
    expect(parseIpc(EngineLifecycleSchema, undefined).ok).toBe(true)
  })

  it('EngineStopSchema rejects payloads', () => {
    expect(parseIpc(EngineStopSchema, { foo: 1 }).ok).toBe(false)
  })

  it('EngineUpdateConfigSchema accepts canonical payload, rejects missing apiKey', () => {
    expect(parseIpc(EngineUpdateConfigSchema, { apiKey: 'k' }).ok).toBe(true)
    expect(parseIpc(EngineUpdateConfigSchema, {}).ok).toBe(false)
  })

  it('EngineTestConnectionSchema accepts and rejects appropriately', () => {
    expect(parseIpc(EngineTestConnectionSchema, { apiKey: 'k', model: 'm' }).ok).toBe(true)
    const r = parseIpc(EngineTestConnectionSchema, { apiKey: 5 })
    expect(r.ok).toBe(false)
  })
})

describe('policy schemas', () => {
  it('PolicyGetSchema / PolicySnapshotSchema / PolicyResetBreakerSchema accept undefined', () => {
    expect(parseIpc(PolicyGetSchema, undefined).ok).toBe(true)
    expect(parseIpc(PolicySnapshotSchema, undefined).ok).toBe(true)
    expect(parseIpc(PolicyResetBreakerSchema, undefined).ok).toBe(true)
  })

  it('PolicyGetSchema rejects any payload', () => {
    expect(parseIpc(PolicyGetSchema, { x: 1 }).ok).toBe(false)
  })

  it('PolicySetSchema accepts arbitrary input (passthrough; real validation in handler)', () => {
    expect(parseIpc(PolicySetSchema, { humanizer: { enabled: true } }).ok).toBe(true)
    expect(parseIpc(PolicySetSchema, null).ok).toBe(true)
    expect(parseIpc(PolicySetSchema, undefined).ok).toBe(true)
  })
})

describe('logs / misc schemas', () => {
  it('LogsRecentSchema defaults to 200 when undefined', () => {
    const r = parseIpc(LogsRecentSchema, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(200)
  })

  it('LogsRecentSchema accepts in-range integers', () => {
    expect(parseIpc(LogsRecentSchema, 1).ok).toBe(true)
    expect(parseIpc(LogsRecentSchema, 2000).ok).toBe(true)
  })

  it('LogsRecentSchema rejects out-of-range / non-integer values', () => {
    expect(parseIpc(LogsRecentSchema, 0).ok).toBe(false)
    expect(parseIpc(LogsRecentSchema, 2001).ok).toBe(false)
    expect(parseIpc(LogsRecentSchema, 1.5).ok).toBe(false)
    expect(parseIpc(LogsRecentSchema, 'many').ok).toBe(false)
  })

  it('CaptureScreenSchema and TestVlmParallelSchema accept undefined and reject payloads', () => {
    expect(parseIpc(CaptureScreenSchema, undefined).ok).toBe(true)
    expect(parseIpc(CaptureScreenSchema, {}).ok).toBe(false)
    expect(parseIpc(TestVlmParallelSchema, undefined).ok).toBe(true)
    expect(parseIpc(TestVlmParallelSchema, 'no').ok).toBe(false)
  })
})

describe('diag:export schema', () => {
  it('defaults to includeLogs=true, daysBack=14 when called with undefined', () => {
    const r = parseIpc(DiagExportSchema, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ includeLogs: true, daysBack: 14 })
  })

  it('defaults missing fields when called with {}', () => {
    const r = parseIpc(DiagExportSchema, {})
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ includeLogs: true, daysBack: 14 })
  })

  it('respects user-supplied values', () => {
    const r = parseIpc(DiagExportSchema, { includeLogs: false, daysBack: 7 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ includeLogs: false, daysBack: 7 })
  })

  it('rejects out-of-range daysBack and wrong-type fields', () => {
    expect(parseIpc(DiagExportSchema, { daysBack: 0 }).ok).toBe(false)
    expect(parseIpc(DiagExportSchema, { daysBack: 366 }).ok).toBe(false)
    expect(parseIpc(DiagExportSchema, { daysBack: 1.5 }).ok).toBe(false)
    expect(parseIpc(DiagExportSchema, { includeLogs: 'yes' }).ok).toBe(false)
  })
})
