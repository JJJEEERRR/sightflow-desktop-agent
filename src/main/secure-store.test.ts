import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SecureStore,
  WRITABLE_SETTING_KEYS,
  buildSettingsForRenderer,
  readSettingForRenderer,
  type KvStore,
  type SafeStorage
} from './secure-store'
import { configureLogger, resetLoggerForTests } from '../core/observability'
import { RingBufferSink } from '../core/observability/sinks/ring-buffer-sink'

interface FakeKvStore extends KvStore {
  _data: Map<string, unknown>
}

function makeStore(initial: Record<string, unknown> = {}): FakeKvStore {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    _data: data,
    get<T = unknown>(key: string): T | undefined {
      return data.get(key) as T | undefined
    },
    set(key: string, value: unknown): void {
      data.set(key, value)
    },
    delete(key: string): void {
      data.delete(key)
    }
  }
}

interface SafeStorageOpts {
  available?: boolean
  throwOnDecrypt?: boolean
}

function makeSafeStorage(opts: SafeStorageOpts = {}): SafeStorage {
  const available = opts.available !== false
  return {
    isEncryptionAvailable: (): boolean => available,
    encryptString: (plain: string): Buffer => Buffer.from(`enc:${plain}`, 'utf-8'),
    decryptString: (buf: Buffer): string => {
      if (opts.throwOnDecrypt) throw new Error('corrupted')
      const s = buf.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('bad-prefix')
      return s.slice(4)
    }
  }
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
  vi.restoreAllMocks()
})

describe('SecureStore — read/write happy path (encryption available)', () => {
  it('returns undefined on a fresh store', () => {
    const ss = new SecureStore({ store: makeStore(), safeStorage: makeSafeStorage() })
    expect(ss.getApiKey()).toBeUndefined()
  })

  it('round-trips setApiKey -> getApiKey', () => {
    const ss = new SecureStore({ store: makeStore(), safeStorage: makeSafeStorage() })
    ss.setApiKey('sk-xxx')
    expect(ss.getApiKey()).toBe('sk-xxx')
  })

  it('persists ciphertext as base64 under apiKeyEncrypted and never writes plaintext', () => {
    const store = makeStore({ apiKey: 'leftover-from-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    ss.setApiKey('sk-xxx')

    const ciphertext = store._data.get('apiKeyEncrypted')
    expect(typeof ciphertext).toBe('string')
    // round-trip the base64 to confirm it decodes to our fake's ciphertext shape
    expect(Buffer.from(ciphertext as string, 'base64').toString('utf-8')).toBe('enc:sk-xxx')
    expect(store._data.has('apiKey')).toBe(false)
  })

  it('setApiKey("") clears both keys', () => {
    const store = makeStore()
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    ss.setApiKey('sk-xxx')
    ss.setApiKey('')
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
    expect(store._data.has('apiKey')).toBe(false)
    expect(ss.getApiKey()).toBeUndefined()
  })

  it('clearApiKey() clears both keys', () => {
    const store = makeStore({ apiKey: 'old-plain', apiKeyEncrypted: 'enc-blob' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    ss.clearApiKey()
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
    expect(store._data.has('apiKey')).toBe(false)
  })
})

describe('SecureStore — setApiKey defensive type guards', () => {
  // The IPC boundary erases TypeScript's `string` guarantee; a buggy renderer
  // can hand us null/undefined/numbers/objects. None of those should be
  // String()-coerced and persisted.
  it('treats null as clear', () => {
    const store = makeStore({
      apiKey: 'old',
      apiKeyEncrypted: Buffer.from('enc:old', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(() => ss.setApiKey(null as unknown as string)).not.toThrow()
    expect(store._data.has('apiKey')).toBe(false)
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
  })

  it('treats undefined as clear', () => {
    const store = makeStore({
      apiKey: 'old',
      apiKeyEncrypted: Buffer.from('enc:old', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(() => ss.setApiKey(undefined as unknown as string)).not.toThrow()
    expect(store._data.has('apiKey')).toBe(false)
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
  })

  it('treats numbers / non-strings as clear', () => {
    const store = makeStore({
      apiKey: 'old',
      apiKeyEncrypted: Buffer.from('enc:old', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(() => ss.setApiKey(123 as unknown as string)).not.toThrow()
    expect(store._data.has('apiKey')).toBe(false)
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
  })
})

describe('SecureStore — encryption unavailable', () => {
  it('writes plaintext under apiKey, clears apiKeyEncrypted, and fires onFallback exactly once', () => {
    const store = makeStore({ apiKeyEncrypted: 'stale-blob' })
    const onFallback = vi.fn<[string], void>()
    const ss = new SecureStore({
      store,
      safeStorage: makeSafeStorage({ available: false }),
      onFallback
    })

    ss.setApiKey('sk-xxx')
    ss.setApiKey('sk-yyy')
    ss.setApiKey('sk-zzz')

    expect(store._data.get('apiKey')).toBe('sk-zzz')
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledWith('encryption-unavailable')
  })

  it('falls back to legacy plaintext apiKey on getApiKey when encryption unavailable', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: false }) })
    expect(ss.getApiKey()).toBe('sk-legacy')
  })
})

describe('SecureStore — migrateLegacyApiKey', () => {
  it('no-op with no legacy key -> { migrated: false, reason: "no-legacy-key" }', () => {
    const ss = new SecureStore({ store: makeStore(), safeStorage: makeSafeStorage() })
    expect(ss.migrateLegacyApiKey()).toEqual({ migrated: false, reason: 'no-legacy-key' })
  })

  it('encrypts + deletes plaintext when legacy + encryption available', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })

    const result = ss.migrateLegacyApiKey()
    expect(result).toEqual({ migrated: true })
    expect(store._data.has('apiKey')).toBe(false)
    const blob = store._data.get('apiKeyEncrypted')
    expect(typeof blob).toBe('string')
    expect(Buffer.from(blob as string, 'base64').toString('utf-8')).toBe('enc:sk-legacy')
  })

  it('no-op when already encrypted -> { migrated: false, reason: "already-encrypted" }', () => {
    const store = makeStore({
      apiKeyEncrypted: Buffer.from('enc:existing', 'utf-8').toString('base64'),
      apiKey: 'lingering-plaintext'
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(ss.migrateLegacyApiKey()).toEqual({ migrated: false, reason: 'already-encrypted' })
    // legacy is left intact — that's the contract; only successful migration deletes it.
    expect(store._data.get('apiKey')).toBe('lingering-plaintext')
  })

  it('no-op when encryption unavailable, leaving plaintext untouched', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: false }) })
    expect(ss.migrateLegacyApiKey()).toEqual({
      migrated: false,
      reason: 'encryption-unavailable'
    })
    expect(store._data.get('apiKey')).toBe('sk-legacy')
    expect(store._data.has('apiKeyEncrypted')).toBe(false)
  })

  it('is idempotent — second call after success returns already-encrypted', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(ss.migrateLegacyApiKey()).toEqual({ migrated: true })
    expect(ss.migrateLegacyApiKey()).toEqual({ migrated: false, reason: 'already-encrypted' })
  })
})

describe('SecureStore — decryption errors', () => {
  it('returns undefined and calls onFallback("decrypt-failed") when decryptString throws', () => {
    const store = makeStore({
      apiKeyEncrypted: Buffer.from('enc:sk', 'utf-8').toString('base64')
    })
    const onFallback = vi.fn<[string], void>()
    const ss = new SecureStore({
      store,
      safeStorage: makeSafeStorage({ throwOnDecrypt: true }),
      onFallback
    })
    expect(ss.getApiKey()).toBeUndefined()
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledWith('decrypt-failed')
  })

  it('returns undefined when apiKeyEncrypted is non-base64 garbage', () => {
    // `Buffer.from(s, 'base64')` does NOT throw on invalid input — it just
    // returns garbage bytes — so the decrypt-failed surface must come from the
    // safeStorage layer rejecting the result, not from the b64 decode itself.
    const store = makeStore()
    store.set('apiKeyEncrypted', 'not%%%base64@@@')
    const onFallback = vi.fn<[string], void>()
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage(), onFallback })
    expect(ss.getApiKey()).toBeUndefined()
    expect(onFallback).toHaveBeenCalledWith('decrypt-failed')
  })

  it('returns undefined when apiKeyEncrypted is the empty string (treated as absent)', () => {
    const store = makeStore()
    store.set('apiKeyEncrypted', '')
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(ss.getApiKey()).toBeUndefined()
  })

  it('returns undefined when apiKeyEncrypted is not a string (treated as absent)', () => {
    const store = makeStore()
    store.set('apiKeyEncrypted', 12345)
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(ss.getApiKey()).toBeUndefined()
  })

  it('still returns legacy plaintext when apiKeyEncrypted is an absent-shaped value (precedence)', () => {
    // Empty/non-string ciphertext fields must not block the legacy fallback —
    // the field is treated as if it weren't there.
    const store = makeStore({ apiKey: 'sk-legacy' })
    store.set('apiKeyEncrypted', '')
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(ss.getApiKey()).toBe('sk-legacy')
  })
})

describe('SecureStore — isEncrypted matrix', () => {
  it('blob present + available = true', () => {
    const store = makeStore({
      apiKeyEncrypted: Buffer.from('enc:sk', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: true }) })
    expect(ss.isEncrypted()).toBe(true)
  })

  it('blob present + unavailable = false', () => {
    const store = makeStore({
      apiKeyEncrypted: Buffer.from('enc:sk', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: false }) })
    expect(ss.isEncrypted()).toBe(false)
  })

  it('plaintext-only + available = false', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: true }) })
    expect(ss.isEncrypted()).toBe(false)
  })

  it('plaintext-only + unavailable = false', () => {
    const store = makeStore({ apiKey: 'sk-legacy' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage({ available: false }) })
    expect(ss.isEncrypted()).toBe(false)
  })
})

describe('SecureStore — default onFallback logs at warn', () => {
  it('emits a warn record with the reason when no onFallback override is supplied', () => {
    const ss = new SecureStore({
      store: makeStore(),
      safeStorage: makeSafeStorage({ available: false })
    })
    ss.setApiKey('sk-xxx')

    const records = logBuffer.getAll()
    const warns = records.filter((r) => r.level === 'warn')
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns.some((r) => r.data?.reason === 'encryption-unavailable')).toBe(true)
    // Defense in depth: the key itself must NEVER appear in any log record.
    for (const r of records) {
      expect(JSON.stringify(r)).not.toContain('sk-xxx')
    }
  })
})

describe('readSettingForRenderer — IPC dispatch helper', () => {
  it('returns the decrypted apiKey for key === "apiKey"', () => {
    const store = makeStore()
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    ss.setApiKey('sk-xxx')
    expect(readSettingForRenderer('apiKey', ss, store)).toBe('sk-xxx')
  })

  it('returns "" for key === "apiKey" when nothing is set', () => {
    const store = makeStore()
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(readSettingForRenderer('apiKey', ss, store)).toBe('')
  })

  it('returns "" for key === "apiKeyEncrypted" even when ciphertext is in the store', () => {
    const store = makeStore({
      apiKeyEncrypted: Buffer.from('enc:sk', 'utf-8').toString('base64')
    })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(readSettingForRenderer('apiKeyEncrypted', ss, store)).toBe('')
  })

  it('returns the underlying value for any other key', () => {
    const store = makeStore({ model: 'gpt-4o', baseURL: 'https://example.com' })
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    expect(readSettingForRenderer('model', ss, store)).toBe('gpt-4o')
    expect(readSettingForRenderer('baseURL', ss, store)).toBe('https://example.com')
  })
})

describe('buildSettingsForRenderer — settings:getAll helper', () => {
  it('strips apiKeyEncrypted, injects decrypted apiKey, leaves other keys untouched', () => {
    const store = makeStore()
    const ss = new SecureStore({ store, safeStorage: makeSafeStorage() })
    ss.setApiKey('sk-xxx')

    const snapshot: Record<string, unknown> = {
      ...Object.fromEntries(store._data),
      model: 'gpt-4o',
      baseURL: 'https://example.com',
      systemPrompt: 'be helpful',
      locale: 'zh'
    }
    const out = buildSettingsForRenderer(snapshot, ss)

    expect(out.apiKey).toBe('sk-xxx')
    expect('apiKeyEncrypted' in out).toBe(false)
    expect(out.model).toBe('gpt-4o')
    expect(out.baseURL).toBe('https://example.com')
    expect(out.systemPrompt).toBe('be helpful')
    expect(out.locale).toBe('zh')
  })

  it('substitutes "" for apiKey when the secure store is empty', () => {
    const ss = new SecureStore({ store: makeStore(), safeStorage: makeSafeStorage() })
    const out = buildSettingsForRenderer({ model: 'x' }, ss)
    expect(out.apiKey).toBe('')
    expect(out.model).toBe('x')
    expect('apiKeyEncrypted' in out).toBe(false)
  })
})

describe('WRITABLE_SETTING_KEYS — renderer-facing allowlist', () => {
  // Pinned to catch silent regressions when settings:set drops a key the
  // renderer is actively round-tripping. If you drop or rename a key here,
  // grep the renderer for `settings:set` payloads first to confirm nothing
  // is relying on the persisted shape.
  it('contains every key the renderer round-trips via settings:set', () => {
    // Mirror of the renderer's settings:set payload (src/renderer/src/App.tsx
    // `handleSave`). `apiKey` is intentionally excluded — it is owned by
    // SecureStore.
    const renderedKeys = ['model', 'baseURL', 'systemPrompt', 'appType']
    for (const key of renderedKeys) {
      expect(WRITABLE_SETTING_KEYS).toContain(key)
    }
  })

  it('excludes the apiKey fields (those are owned by SecureStore)', () => {
    expect(WRITABLE_SETTING_KEYS as readonly string[]).not.toContain('apiKey')
    expect(WRITABLE_SETTING_KEYS as readonly string[]).not.toContain('apiKeyEncrypted')
  })
})
