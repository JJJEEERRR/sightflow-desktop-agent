# ADR-0008: Use Electron `safeStorage` instead of `keytar` for API-key at-rest encryption

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: security, secrets, electron

## Context

Spec §3.6 prescribes encrypted at-rest storage of the user's OpenAI-compatible
API key on the user's machine, naming `keytar` as the reference implementation
(OS-keychain backed: DPAPI on Windows, Keychain on macOS, libsecret on Linux).

`keytar` has aged poorly for our project specifically:

- **Native module.** `keytar` ships C++ bindings that need `node-gyp` rebuilds
  per Node/Electron version. We already maintain one native dependency
  (`@hurdlegroup/robotjs`) under `patch-package`; adding a second amplifies the
  Phase-0 fragility we documented in ADR-0002.
- **Windows install pain.** Recurring `node-gyp` failures on Windows older
  than 10, plus VS Build Tools / Python 3.11 prerequisites that already cost
  us a separate ADR (ADR-0003).
- **Maintenance.** The upstream project is in maintenance mode; the
  npm/electron community has been moving toward built-in `safeStorage`.

## Decision

Use **Electron's built-in `safeStorage` API** for at-rest encryption of the
API key. Wrap it in a small `SecureStore` class (see `src/main/secure-store.ts`)
so the rest of the main process keeps a clean `getApiKey() / setApiKey() /
clearApiKey()` surface and so we can fake `safeStorage` in unit tests without
booting an Electron app context.

`safeStorage` provides the same security property as `keytar` — OS-level
crypto bound to the logged-in user account:

- **Windows:** DPAPI
- **macOS:** Keychain (per-app entry)
- **Linux:** Secret Service / kwallet when available; otherwise plaintext with
  an explicit warning.

Available since Electron 14; we are on Electron 39, so no version constraint.

## Consequences

### Positive

- **Zero new native dependencies.** No `node-gyp`, no `patch-package` entry,
  no new prebuilt-binary download URL to babysit in CI.
- **No new Windows install footgun.** The flaky path that bit us under
  ADR-0003 stays bypassed.
- **Smaller surface area.** `safeStorage` is three functions
  (`isEncryptionAvailable`, `encryptString`, `decryptString`); easier to
  reason about and test than a keychain abstraction with named
  service/account tuples.

### Negative

- **Decrypted blob is bound to the user account on the machine.** If the user
  copies `<userData>/settings.json` to a new machine the ciphertext is
  unrecoverable and they have to re-enter the key. We treat this as a feature
  (it's the same property as a fresh OS install) — the threat model targets
  on-disk theft, not migration convenience.
- **Linux without Secret Service falls back to plaintext.** `SecureStore`
  detects this via `safeStorage.isEncryptionAvailable()` and writes the
  legacy `apiKey` field instead, after firing a one-time `onFallback`
  warning. The app still works; the user just isn't getting the at-rest
  protection they would on Windows / macOS.

### Neutral

- Migration on first run after upgrade is handled by
  `SecureStore.migrateLegacyApiKey()`: any plaintext `apiKey` left in
  `settings.json` is encrypted in place and the plaintext field is deleted.
  Idempotent and safe to call on every boot.

## Alternatives considered

- **`keytar`** (the spec's original choice): rejected for the reasons above —
  native module, Windows install pain, slowing maintenance.
- **`@napi-rs/keyring`**: also a native module, less mature on Windows, no
  meaningful security advantage over `safeStorage`.
- **Roll our own AES-GCM with a key derived from a machine-bound seed**:
  rejected — reinventing what the OS already gives us, with a much larger
  attack surface.
