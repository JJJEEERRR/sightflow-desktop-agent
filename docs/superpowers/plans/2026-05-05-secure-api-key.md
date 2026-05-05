# Secure API Key Storage Implementation Plan

> **For agentic workers:** Single-task plan. Use TDD. The full task description below is what the implementer subagent receives — no need to read this file.

**Goal:** Stop storing the user's `apiKey` as plaintext in `<userData>/settings.json`. Encrypt it at rest with Electron's built-in `safeStorage` (OS-native crypto: DPAPI on Windows, Keychain on macOS, Secret Service on Linux). On platforms where encryption is unavailable (some headless Linux), fall back to plaintext storage with a one-time warning log so the app keeps working.

**Architecture:** A small `core/secure-store.ts` wrapper around `electron-store` exposing `getApiKey() / setApiKey() / clearApiKey()`. It encrypts/decrypts via `safeStorage` and persists the ciphertext as a base64 string under `apiKeyEncrypted`. On the first run after upgrade, a migration helper transparently moves any plaintext `apiKey` from the old key into `apiKeyEncrypted` and clears the plaintext. Main-process call sites (settings IPC, engine:start, engine:testConnection, test:vlm-parallel) all go through the wrapper.

**Tech Stack:** TypeScript, Electron `safeStorage` (already available — Electron 14+; the project is on Electron 39), existing `electron-store`, vitest. **No new dependencies.**

---

## Module API (locked)

```ts
// src/main/secure-store.ts (NEW)

import type Store from 'electron-store'

/**
 * SafeStorage facade — extracted so unit tests can inject a fake without
 * needing a running Electron app. Real impl wraps `electron.safeStorage`.
 */
export interface SafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

/** electron-store-shaped subset; allows tests to pass a Map-backed fake. */
export interface KvStore {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export interface SecureStoreOptions {
  store: KvStore
  safeStorage: SafeStorage
  /** Called once if encryption is unavailable. Default: console.warn. */
  onFallback?: (reason: string) => void
}

export class SecureStore {
  constructor(opts: SecureStoreOptions)

  /** Returns the decrypted API key, or undefined when not set. */
  getApiKey(): string | undefined

  /** Encrypts and persists. Empty string is treated as "clear". */
  setApiKey(value: string): void

  /** Removes both the encrypted blob and any legacy plaintext value. */
  clearApiKey(): void

  /**
   * One-shot migration of legacy plaintext `apiKey` → encrypted
   * `apiKeyEncrypted`. Called explicitly at app startup (after
   * app.whenReady, because safeStorage requires it). Idempotent — safe to
   * call twice.
   */
  migrateLegacyApiKey(): { migrated: boolean; reason?: string }

  /** True iff this instance is using OS-level encryption. */
  isEncrypted(): boolean
}
```

### Behavior contracts (test these)

**Storage layout:**

- New encrypted key: `apiKeyEncrypted` — base64 of `safeStorage.encryptString(value)` Buffer.
- Legacy plaintext key: `apiKey` — left for migration; cleared by `clearApiKey()` and `migrateLegacyApiKey()`.

**`getApiKey()`:**

- If `apiKeyEncrypted` is a non-empty string AND `safeStorage.isEncryptionAvailable()`: decrypt + return.
- Else if `apiKey` (legacy plaintext) is a non-empty string: return as-is. (Fallback path; covers "encryption unavailable" + "migration not yet run" scenarios.)
- Else: `undefined`.
- If decryption throws (corruption / different machine): catch, log warning via `onFallback(reason)`, return undefined. Do NOT crash.

**`setApiKey(value)`:**

- Empty string → call `clearApiKey()` (so the user can remove the key by saving an empty input).
- Non-empty + encryption available: `safeStorage.encryptString(value)`, store base64 under `apiKeyEncrypted`, delete plaintext `apiKey` (if any).
- Non-empty + encryption NOT available: store plaintext under `apiKey` for backwards compat, delete `apiKeyEncrypted`. Call `onFallback('encryption-unavailable')` exactly once per process.

**`migrateLegacyApiKey()`:**

- If `apiKeyEncrypted` already exists: no-op, returns `{ migrated: false, reason: 'already-encrypted' }`.
- Else if `apiKey` is empty/missing: no-op, returns `{ migrated: false, reason: 'no-legacy-key' }`.
- Else if encryption unavailable: no-op, returns `{ migrated: false, reason: 'encryption-unavailable' }`.
- Else: encrypt, store, delete plaintext, return `{ migrated: true }`.
- Must be idempotent — calling twice in a row never produces a different result on the second call.

**`isEncrypted()`:**

- True iff there is an `apiKeyEncrypted` value AND `safeStorage.isEncryptionAvailable()`. False otherwise.

### Logging

- Use `getLogger('main.secure-store')`.
- Log at info level on successful migration with: `{ keyLengthBefore: number, encrypted: true }` (do NOT log the key itself).
- Log at warn on fallback / decrypt failure with reason.

---

## Wiring into main/index.ts

1. Build the SecureStore once after `app.whenReady()` (before any other code reads the api key):

```ts
// inside app.whenReady().then(async () => { ... })
const { safeStorage } = await import('electron')
const secureStore = new SecureStore({
  store: settingsStore as unknown as KvStore,
  safeStorage,
  onFallback: (reason) => log.warn('secure-store fallback', { reason })
})
secureStore.migrateLegacyApiKey()
```

2. Replace all 4 call sites in `src/main/index.ts`:
   - `settings:getAll` handler — replace `return settingsStore.store` with a custom payload that:
     - Loads the entire store via `settingsStore.store`
     - Removes `apiKeyEncrypted` from the returned object
     - Adds `apiKey: secureStore.getApiKey() ?? ''`
   - `settings:get` handler — when key === 'apiKey', return `secureStore.getApiKey() ?? ''`; else delegate to `settingsStore.get(key)` as before. Never expose `apiKeyEncrypted` to the renderer.
   - `settings:set` handler — when input has an `apiKey` field, route it through `secureStore.setApiKey(value)` and strip it from the rest before `settingsStore.set` runs on the remaining fields.
   - `test:vlm-parallel` handler — replace `settingsStore.get('apiKey') as string` with `secureStore.getApiKey() ?? ''`.

3. The `engine:start` and `engine:testConnection` handlers receive `apiKey` directly from the renderer payload — no change needed (the renderer already has the decrypted key from `settings:getAll`).

4. Module-load `defaults: { apiKey: '', ... }` stays as-is for backwards compat. Adding `apiKeyEncrypted` to defaults is optional; we treat its absence as "not set". Do NOT add it to defaults.

---

## Tests

Two test files:

### `src/main/secure-store.test.ts` (NEW)

Use the Map-backed fake `KvStore` and a mocked `SafeStorage`:

```ts
function makeStore(): KvStore & { _data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    _data: data,
    get<T>(key: string): T | undefined {
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

function makeSafeStorage(
  opts: { available?: boolean; throwOnDecrypt?: boolean } = {}
): SafeStorage {
  const available = opts.available !== false
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buf) => {
      if (opts.throwOnDecrypt) throw new Error('corrupted')
      const s = buf.toString('utf-8')
      if (!s.startsWith('enc:')) throw new Error('bad-prefix')
      return s.slice(4)
    }
  }
}
```

Cover at minimum (~14 tests):

1. `getApiKey()` returns undefined on a fresh store.
2. `setApiKey('sk-xxx')` then `getApiKey()` round-trips when encryption available.
3. `setApiKey('sk-xxx')` writes `apiKeyEncrypted` (base64 string) and does NOT write `apiKey`.
4. `setApiKey('')` clears both keys.
5. `clearApiKey()` clears both keys.
6. With encryption unavailable: `setApiKey('sk-xxx')` writes plaintext to `apiKey` and clears `apiKeyEncrypted`; `onFallback` is called exactly once even on multiple writes.
7. Migration with no legacy key: no-op, returns `{ migrated: false, reason: 'no-legacy-key' }`.
8. Migration with legacy plaintext key + encryption available: encrypts, deletes plaintext, returns `{ migrated: true }`.
9. Migration when already encrypted: no-op, returns `{ migrated: false, reason: 'already-encrypted' }`.
10. Migration with encryption unavailable: no-op, returns `{ migrated: false, reason: 'encryption-unavailable' }`. Plaintext is NOT cleared.
11. Migration is idempotent — calling twice gives `{ migrated: true }` then `{ migrated: false, reason: 'already-encrypted' }`.
12. `getApiKey()` falls back to plaintext `apiKey` when only the legacy key is set (regardless of encryption availability).
13. Decryption throws → returns undefined + onFallback called.
14. `isEncrypted()` reflects the actual storage state (true iff encrypted blob exists AND safeStorage available).

Configure the logger in `beforeEach` with a `RingBufferSink` and call `resetLoggerForTests()` in `afterEach`. (See `src/core/runtime/watchdog.test.ts` for the pattern.) Do NOT import the real `electron` module — pass the fake `SafeStorage` everywhere.

---

## Quality gates (your responsibility)

Before reporting DONE, run all of these from the project root and confirm pass:

```
npm run lint
npm run typecheck
npx vitest run src/main/secure-store.test.ts
npx vitest run                          # ensure no regressions in the 362 existing tests
npm run build
```

If lint reports prettier warnings, run `npx eslint --fix src/main/secure-store.ts src/main/secure-store.test.ts src/main/index.ts` and re-verify.

---

## Out of scope

- Renderer-side masking (showing `***` instead of the real key in the input). The settings page already uses `<input type="password">`, which prevents shoulder-surfing. Encrypted-at-rest is the goal.
- IPC channel for "rotate / re-encrypt" (the renderer just calls `settings:set` with a new key — that re-encrypts).
- Removing the legacy `apiKey: ''` default from electron-store defaults (do that in a future cleanup once we're confident migrations have run for all users).
- Per-machine key recovery on stolen-disk scenarios — `safeStorage` already binds to the machine; that's the property we want.

---

## ADR

Write a brief ADR `docs/adr/0008-electron-safestorage-instead-of-keytar.md` recording the deviation from spec §3.6 (which prescribed keytar). Justify on the basis of: zero new native deps, identical security property (OS-level crypto), simpler Windows install, no patch-package needed.
