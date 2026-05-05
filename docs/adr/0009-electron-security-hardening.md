# ADR-0009: Electron renderer hardening and packaging baseline

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: security, electron, packaging

## Context

Up until Phase 4 the desktop agent's `BrowserWindow` was constructed with the
`electron-vite` template defaults: a single `webPreferences.sandbox: false`
override and otherwise implicit defaults inherited from Electron 39. There was
no Content-Security-Policy, no navigation guard, and no explicit declaration
of the `nodeIntegration*` family of toggles. `electron-builder.yml` was
similarly minimal — no explicit `asar` setting, no Windows code-signing
scaffolding, no macOS Hardened Runtime — which is acceptable for an internal
build but unsafe to ship.

Four threats motivate this hardening pass:

1. **XSS in the renderer pivoting to RCE.** The renderer renders LLM output,
   localized strings, and screenshot data. A future regression (or a
   compromised dependency) that lets attacker-controlled markup land in the
   DOM must not be able to execute arbitrary JavaScript, let alone reach
   Node.js APIs through the preload bridge.
2. **Renderer navigating away from its initial origin.** A redirected
   renderer can host attacker-controlled JavaScript that will then attempt to
   call our `contextBridge`-exposed `window.electron.invoke(...)` channels —
   any IPC-level allowlist gap suddenly becomes exploitable. Same threat
   class as `target=_blank` link-jacking, but in-place.
3. **Prototype pollution and Node-API leakage.** With `nodeIntegration: true`
   or `contextIsolation: false`, a single XSS gives the attacker `require()`
   and direct access to the main process's globals. Electron 39 defaults are
   correct, but a typo in `webPreferences` could silently undo that — making
   the toggles explicit means the next code review catches a regression.
4. **Distribution tampering and Gatekeeper / SmartScreen warnings.** An
   unsigned packaged build can be altered post-download (any of the JS
   bundles outside `app.asar` are plain files) and triggers OS-level "this is
   from an unidentified developer" friction that pushes users toward
   click-through-and-ignore behavior. A signed, hardened-runtime build is the
   long-term answer; this ADR sets up the scaffolding without yet requiring
   credentials.

## Decision

### `BrowserWindow.webPreferences`

We set, in `src/main/index.ts`'s `createWindow`:

- `contextIsolation: true` — already the Electron 39 default, but explicit
  because it is the single most important security flag (it is what makes
  the preload's `contextBridge` actually a bridge, not a wide-open window).
- `nodeIntegration: false`, `nodeIntegrationInWorker: false`,
  `nodeIntegrationInSubFrames: false` — the renderer must never see
  `require`, `process`, or `Buffer`. Defaults today, explicit forever.
- `sandbox: false` — left as-is. The preload uses Node-side modules
  (`ipcRenderer`, plus the helpers we bridge through `contextBridge`) that
  the renderer-process sandbox would block. With `contextIsolation: true`
  the sandbox is not the only line of defense — the renderer's JS world
  cannot reach Node directly regardless. A future preload rewrite that
  drops Node-side dependencies could enable `sandbox: true` for additional
  defense in depth; that work is deferred (see Open items).
- `webSecurity: true`, `allowRunningInsecureContent: false`,
  `experimentalFeatures: false` — defaults; explicit for the same
  regression-detection reason as the `nodeIntegration*` group.

### Content-Security-Policy

We attach a strict CSP via
`mainWindow.webContents.session.webRequest.onHeadersReceived`, built by
`src/main/security-headers.ts` (unit-tested standalone). The policy:

- `default-src 'self'`
- `script-src 'self'` in production. In dev we additionally allow
  `'unsafe-inline'` and `'unsafe-eval'` because Vite HMR injects inline
  client-bootstrap scripts and uses `eval` for module evaluation. The dev
  build is never shipped, and the renderer URL is loopback-only.
- `style-src 'self' 'unsafe-inline'` — React injects inline style
  attributes; the threat from `style=""` is bounded (no script execution),
  and removing this directive would force the entire renderer onto a CSS
  audit pass we have not budgeted.
- `img-src 'self' data: blob:` — screenshots arrive as `data:image/png` and
  intermediate processing can produce `blob:` URLs.
- `connect-src 'self'` — the renderer makes **no** direct outbound HTTP
  calls today. All LLM traffic goes through the main process via the
  `engine:*` IPC channels and `OpenAICompatProvider` in
  `src/core/brain/providers/openai-compat.ts`. This was verified by
  grepping `src/renderer` for `fetch(` / `XMLHttpRequest` (zero matches).
  If the renderer ever needs to talk to a third-party endpoint directly,
  that becomes a deliberate ADR — not a one-line CSP relaxation.
- `font-src 'self' data:` — `data:` is required by some font loaders that
  inline glyph subsets.
- `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`,
  `form-action 'none'` — close common XSS escape hatches (Flash-style
  plugins, framing, base-tag hijacking, form exfiltration).

We also send `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
and `Referrer-Policy: no-referrer` as belt-and-suspenders defenses.

### `setWindowOpenHandler`

The existing `return { action: 'deny' }` + `shell.openExternal(details.url)`
handler stays. The security property: the renderer cannot create new
`BrowserWindow` instances (so no `target=_blank` link-jacking, no popup
windows that would inherit our preload). Every `window.open(...)` URL is
handed to the OS-level URL handler, which applies its own policy (default
browser, mailto: client, etc.).

### Navigation guard

A new `webContents.on('will-navigate', ...)` handler blocks any in-place
navigation away from the renderer's initial origin. Same-origin navigation
is allowed (Vite full-reload, internal SPA routes that bypass the router);
anything else is `event.preventDefault()`-ed and logged at `warn`. In dev
this is the loopback Vite URL; in prod it is the `file://` to
`out/renderer/index.html`.

### `electron-builder.yml`

- `asar: true` — explicit. Renderer code lives inside `app.asar`, raising
  the bar against casual file-replacement tampering on disk.
- `asarUnpack: resources/**` — kept. The engine reads icon/locale/RPA
  resources via plain `fs.readFile`, which cannot traverse asar archives.
- Windows code-signing scaffolding is included as commented-out config,
  with operator-facing comments naming the two env vars (`CSC_LINK`,
  `CSC_KEY_PASSWORD`) that need to be present before un-commenting. The
  build still works without a certificate today; uncommenting is a deliberate
  step the operator takes once the cert is provisioned.
- macOS `hardenedRuntime: true` — turned on now so the only change required
  for notarization later is `notarize: true` plus credentials.
- `notarize: false` — unchanged. Notarization requires Apple Developer ID
  credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`)
  which are not yet provisioned.

## Consequences

### Positive

- **Clean security baseline.** Every `webPreferences` toggle is explicit,
  every renderer response carries a strict CSP, and the renderer is pinned
  to its initial origin. A future regression that flips any of these
  defaults shows up in a one-line diff.
- **Ready for code-signing.** The Windows config has a single un-comment
  step to enable signing; the macOS config has Hardened Runtime on
  pre-emptively, so notarization becomes a credentials-only follow-up.
- **Smaller blast radius from third-party dependency XSS.** Strict CSP +
  navigation guard + `setWindowOpenHandler` deny mean a future renderer
  vulnerability cannot, on its own, reach the network or pivot to another
  origin without main-process cooperation.

### Negative

- **CSP friction for new third-party UI libs.** Any future dependency that
  injects inline `<script>` or makes `fetch(...)` calls from the renderer
  will fail under the production CSP. Workaround: route the network call
  through main via a new IPC channel (preferred — keeps our existing audit
  surface), or relax the directive via a dedicated ADR (must justify the
  expansion). Existing inline-style usage by React is already accommodated.
- **`'unsafe-eval'` allowance in dev.** Necessary for Vite HMR; never
  shipped, but worth flagging because some security checklists score the
  dev policy as if it were production. Mitigation: documented dev/prod
  divergence is gated explicitly on `is.dev`, unit-tested in
  `security-headers.test.ts`.

### Neutral

- **No change to runtime IPC behavior.** The IPC channel allowlist stays
  exactly as the preload+main define it today; this ADR hardens the
  perimeter, not the bridge.

## Alternatives considered

- **`sandbox: true`.** Rejected for now. The preload imports Electron
  modules and uses `contextBridge` to expose IPC; flipping the sandbox to
  `true` would block parts of the preload's Node access and force a preload
  rewrite (every Node-side helper would have to move into a separate
  trusted main-process function and be invoked over IPC by the preload).
  With `contextIsolation: true` the renderer cannot reach Node regardless,
  so the marginal security gain doesn't justify the rewrite right now.
  Revisit after Phase 5.
- **Strict `style-src 'self'` (drop `'unsafe-inline'`).** Rejected. React
  and our component library inject inline `style=""` attributes for
  layout. Removing `'unsafe-inline'` would break the entire UI. The threat
  class is bounded (inline styles cannot execute JS), so the cost / benefit
  doesn't pencil out. Revisit during the Phase-5 frontend refactor when
  we can audit every inline style site.
- **CSP via `<meta>` tag in `index.html`.** Rejected: `<meta>`-delivered
  CSP cannot set `frame-ancestors` (irrelevant here) and is harder to
  parameterise on `is.dev`. The header-based path is also what we'd use
  if we ever served the renderer from a real HTTP origin.
- **Separate `Permissions-Policy` header.** Considered but skipped — the
  renderer doesn't request any of the gated APIs (geolocation, camera,
  etc.), and `webSecurity: true` plus the absent permissions handler in
  the main process already deny by default.

## Open items

The following are deliberately deferred and tracked here so the next
hardening pass picks them up cleanly:

- **Windows code-signing.** Requires an EV or OV code-signing certificate.
  Once `CSC_LINK` / `CSC_KEY_PASSWORD` are provisioned in CI, uncomment the
  `signtoolOptions` block in `electron-builder.yml`.
- **macOS notarization.** Flip `notarize: true` and supply `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env vars. Hardened
  Runtime is already enabled; existing entitlements
  (`build/entitlements.mac.plist`) already grant the JIT exemptions
  Electron needs.
- **Auto-update wiring** (electron-updater + signed update channel).
  Out of scope for this PR; will need a separate ADR to choose a release
  channel layout.
- **`sandbox: true`.** Requires the preload rewrite described above.
- **Renderer-side telemetry / error reporting endpoint.** If/when added,
  it must come with an explicit `connect-src` directive and an ADR that
  audits what data is sent.
