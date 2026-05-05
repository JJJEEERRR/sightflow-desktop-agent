import { getLogger } from '../core/observability'

/**
 * Subset of Electron's `safeStorage` we depend on. Defining it as a local
 * interface (instead of importing `SafeStorage` from 'electron') keeps the
 * production module testable in plain Node — no Electron app context required
 * to construct fakes.
 */
export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

/**
 * Minimal key/value persistence surface. `electron-store` already implements
 * this shape (the cast is done at the call site in `src/main/index.ts`), and
 * tests inject an in-memory `Map`-backed fake.
 */
export interface KvStore {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface SecureStoreOptions {
  store: KvStore
  safeStorage: SafeStorage
  /** Called once if encryption is unavailable. Default: log via getLogger('main.secure-store'). */
  onFallback?: (reason: string) => void
}

const ENCRYPTED_KEY = 'apiKeyEncrypted'
const LEGACY_KEY = 'apiKey'

type MigrationReason = 'already-encrypted' | 'no-legacy-key' | 'encryption-unavailable'

export interface MigrationResult {
  migrated: boolean
  reason?: MigrationReason
}

/**
 * Encrypts the user's API key at rest using Electron's built-in `safeStorage`
 * (DPAPI on Windows, Keychain on macOS, Secret Service on Linux).
 *
 * Layout in the underlying KV store:
 *  - `apiKeyEncrypted` — base64 of the ciphertext Buffer. Never exposed to the renderer.
 *  - `apiKey`          — legacy plaintext field. Read-only path for migration
 *                        and for platforms where encryption is unavailable.
 *
 * Failure modes:
 *  - On platforms without an OS keychain (e.g. Linux without Secret Service),
 *    falls back to plaintext storage and emits a one-time `onFallback`
 *    warning so the app keeps working.
 *  - On corruption / different-machine decryption errors, returns `undefined`
 *    rather than crashing.
 */
export class SecureStore {
  private readonly store: KvStore
  private readonly safeStorage: SafeStorage
  private readonly onFallback: (reason: string) => void
  private readonly log = getLogger('main.secure-store')
  private unavailableWarned = false

  constructor(opts: SecureStoreOptions) {
    this.store = opts.store
    this.safeStorage = opts.safeStorage
    this.onFallback =
      opts.onFallback ??
      ((reason: string): void => {
        this.log.warn('secure-store fallback', { reason })
      })
  }

  getApiKey(): string | undefined {
    const encrypted = this.readEncryptedBlob()
    if (encrypted !== undefined && this.safeStorage.isEncryptionAvailable()) {
      try {
        return this.safeStorage.decryptString(encrypted)
      } catch (err) {
        // The structured logger captures the underlying error name/message/stack.
        // The `onFallback` channel only carries a stable kind string ('decrypt-failed')
        // so callers can match on it programmatically without consuming raw error text.
        this.log.warn('apiKey decrypt failed', { err })
        this.onFallback('decrypt-failed')
        return undefined
      }
    }

    const legacy = this.readLegacyPlaintext()
    if (legacy !== undefined) {
      return legacy
    }
    return undefined
  }

  setApiKey(value: string): void {
    // Defensive: TypeScript can't enforce the `string` annotation across an IPC
    // boundary, and a buggy renderer could send `null`, `undefined`, a number,
    // etc. Treat anything that isn't a non-empty string as "clear the key"
    // rather than persisting `String(value)` garbage like `"null"`.
    if (typeof value !== 'string' || value === '') {
      this.clearApiKey()
      return
    }

    if (this.safeStorage.isEncryptionAvailable()) {
      const cipher = this.safeStorage.encryptString(value)
      this.store.set(ENCRYPTED_KEY, cipher.toString('base64'))
      this.store.delete(LEGACY_KEY)
      return
    }

    this.store.set(LEGACY_KEY, value)
    this.store.delete(ENCRYPTED_KEY)
    this.warnUnavailableOnce()
  }

  clearApiKey(): void {
    this.store.delete(ENCRYPTED_KEY)
    this.store.delete(LEGACY_KEY)
  }

  /**
   * One-time on-upgrade migration: if the legacy plaintext `apiKey` is set but
   * `apiKeyEncrypted` is not, encrypt and rewrite. Idempotent: a second call
   * after a successful migration returns `already-encrypted` instead of
   * re-running.
   */
  migrateLegacyApiKey(): MigrationResult {
    if (this.readEncryptedBlob() !== undefined) {
      return { migrated: false, reason: 'already-encrypted' }
    }
    const legacy = this.readLegacyPlaintext()
    if (legacy === undefined) {
      return { migrated: false, reason: 'no-legacy-key' }
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.warnUnavailableOnce()
      return { migrated: false, reason: 'encryption-unavailable' }
    }
    const cipher = this.safeStorage.encryptString(legacy)
    this.store.set(ENCRYPTED_KEY, cipher.toString('base64'))
    this.store.delete(LEGACY_KEY)
    this.log.info('legacy apiKey migrated to safeStorage', { encrypted: true })
    return { migrated: true }
  }

  isEncrypted(): boolean {
    return this.readEncryptedBlob() !== undefined && this.safeStorage.isEncryptionAvailable()
  }

  private readEncryptedBlob(): Buffer | undefined {
    const raw = this.store.get<unknown>(ENCRYPTED_KEY)
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    return Buffer.from(raw, 'base64')
  }

  private readLegacyPlaintext(): string | undefined {
    const raw = this.store.get<unknown>(LEGACY_KEY)
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    return raw
  }

  private warnUnavailableOnce(): void {
    if (this.unavailableWarned) return
    this.unavailableWarned = true
    this.onFallback('encryption-unavailable')
  }
}

// ─── Pure helpers for IPC-handler use ───────────────────────────────────────
//
// Extracted so the apiKey / apiKeyEncrypted special-casing in the
// `settings:get` and `settings:getAll` handlers is unit-testable without
// booting Electron's IPC layer. The handlers in `src/main/index.ts` are
// one-line wrappers around these.
//
// Defense-in-depth properties they encode:
//   - the renderer can never read the ciphertext blob (`apiKeyEncrypted`
//     always returns `''`, even if a future refactor accidentally falls
//     through to the underlying store)
//   - the renderer-facing `apiKey` field is always the decrypted plaintext
//     (or empty string), never the ciphertext

/**
 * Writable settings keys exposed to the renderer over `settings:set`.
 *
 * Excludes `apiKey` and `apiKeyEncrypted` — those are owned exclusively by
 * `SecureStore`. Adding a new public setting must be a deliberate edit to
 * this list, not an accidental rest-destructure pass-through.
 */
export const WRITABLE_SETTING_KEYS = [
  'model',
  'baseURL',
  'systemPrompt',
  'locale',
  'appType',
  'antiDetection'
] as const

export type WritableSettingKey = (typeof WRITABLE_SETTING_KEYS)[number]

/**
 * Resolve a single settings key for the renderer side. Routes the apiKey
 * fields through the secure store; everything else is read straight from the
 * underlying KV store.
 */
export function readSettingForRenderer(
  key: string,
  secureStore: Pick<SecureStore, 'getApiKey'>,
  fallback: KvStore
): unknown {
  if (key === 'apiKey') return secureStore.getApiKey() ?? ''
  if (key === ENCRYPTED_KEY) return ''
  return fallback.get(key)
}

/**
 * Build the renderer-facing settings snapshot for `settings:getAll`. Strips
 * the ciphertext field, substitutes the decrypted apiKey, leaves every other
 * key untouched.
 */
export function buildSettingsForRenderer(
  snapshot: Record<string, unknown>,
  secureStore: Pick<SecureStore, 'getApiKey'>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...snapshot }
  delete out[ENCRYPTED_KEY]
  out.apiKey = secureStore.getApiKey() ?? ''
  return out
}
