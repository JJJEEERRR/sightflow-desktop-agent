# ADR-0002: Keep `@hurdlegroup/robotjs` and `patch-package` for input automation

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: rpa, native-modules

## Context

The repo uses `@hurdlegroup/robotjs ^0.12.3` for keyboard/mouse simulation, plus
`patch-package` to maintain local fixes against it. Native modules in Electron
applications are notoriously fragile across Node and Electron versions, and
robotjs is detectable by some anti-automation systems (a concern for the
"反封号" objective in spec §3.2).

Phase 0 must decide whether to keep this stack untouched. Replacing the input
backend (e.g. with `nut-tree`, `node-key-sender`, raw `SendInput` via FFI, or
even shipping a separate driver) is a multi-week effort that is **not** in
Phase 0 scope.

## Decision

**Keep `@hurdlegroup/robotjs` and the `patches/` directory for now.** Phase 3
will revisit the question once the anti-detection middleware is in place — if
it turns out that humanizer-level mitigations are insufficient, switching the
input backend becomes a Phase-3 follow-up plan, not a Phase-0 fire drill.

The `humanizer` middleware introduced in Phase 3 will be the _first_ line of
defense (randomized timing, jitter, bezier paths). It is designed so that
swapping the input backend later is an isolated change inside `core/device/`.

## Consequences

### Positive

- Phase 0 ships with zero risk to the existing working RPA flow.
- The `patches/` directory documents real bugs we've already fixed; throwing
  them away would be wasteful.

### Negative

- robotjs ships native binaries that need rebuilds on Node/Electron upgrades.
  Phase 0 mitigates by locking Node version (`.nvmrc`) and adding the
  `build-verify` CI workflow that rebuilds on Windows+macOS.
- robotjs uses standard OS input APIs that some anti-automation systems can
  flag. We accept this risk for now and rely on humanizer/circuit-breaker.

### Neutral

- `patch-package` runs in `postinstall`. CI workflows that don't need native
  modules use `npm ci --ignore-scripts` plus a separate `npx patch-package`
  step (see `lint-typecheck.yml`).

## Alternatives considered

- **Replace robotjs with nut-tree** (or similar): out of scope for Phase 0; may
  reconsider in Phase 3 if humanizer alone is insufficient.
- **Drop `patch-package` and fork robotjs:** more maintenance burden than
  patches; not justified.
