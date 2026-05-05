# ADR-0003: Pin Python 3.11 in CI for native-module compilation

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: ci, native-modules

## Context

Phase 0 added three GitHub Actions workflows. The first run on PR #1 produced:

- `Lint & Typecheck` (Linux): green ✅
- `Test` (windows-latest, macos-latest): red ❌
- `Build Verify` (windows-latest, macos-latest): red ❌

Both `Test` and `Build Verify` failed at `npm ci` while `node-gyp` was rebuilding
`node-window-manager`. The runtime error from the runner:

```
ModuleNotFoundError: No module named 'distutils'
  File ".../node_modules/node-gyp/gyp/pylib/gyp/input.py", line 19, in <module>
    from distutils.version import StrictVersion
```

Root cause:

- The repo's `package-lock.json` resolves `node-gyp@9.4.1` (transitive dep of
  `node-window-manager` and `@hurdlegroup/robotjs`).
- `node-gyp@9.4.1` ships a vendored copy of `gyp` that imports `distutils`.
- Python 3.12 removed `distutils` from the standard library (PEP 632).
- GitHub Actions runners ship Python 3.12 by default in their 2026 image.
- Pre-flight on the developer's local Windows machine succeeded because that
  machine still has Python 3.11 (or earlier) on PATH.

This is a transitional issue: bumping `node-gyp` to v10+ resolves it (gyp was
rewritten without `distutils`), but the affected packages (`node-window-manager`,
`@hurdlegroup/robotjs`) declare `node-gyp@^9` as a peer/build-time dep and don't
transparently benefit from a newer copy without `npm overrides`.

## Decision

In the Phase-0 CI workflows that compile native modules (`test.yml` and
`build-verify.yml`), insert an explicit `actions/setup-python@v5` step pinning
Python **3.11** _before_ `npm ci`. We do **not** pin Python in the
`lint-typecheck` workflow because that one already runs `npm ci --ignore-scripts`
and never invokes node-gyp.

We do **not** add a `node-gyp` override to `package.json` at this time, because:

1. Tests and downstream tooling would all use the override, including the
   developer's local install, where Python 3.11 is currently expected to work.
2. The override surface for native build tools is rarely safe (shipped binaries
   may not link cleanly against a newer node-gyp's expectations).
3. node-window-manager and robotjs may release maintenance versions in 2026
   that natively bundle node-gyp@10. When that happens we can drop both this
   ADR and the Python pin in one cleanup PR.

## Consequences

### Positive

- Phase 0's `Test` and `Build Verify` matrices unblock immediately.
- Zero changes to `package.json` / `package-lock.json` — purely a CI fix.
- Documented and reversible.

### Negative

- Adds ~10–20s per matrix job to install Python (cached after first run).
- Pins us to a Python 3.11 baseline in CI even after we no longer need it.
  Mitigation: revisit when bumping `node-gyp` (see "Reversibility" below).
- Local developer machines that don't already have Python 3.11 on PATH may hit
  the same `distutils` error on `npm install`. Mitigation: documented in
  `docs/CONTRIBUTING.md` "Native build tools" section under a follow-up
  amendment.

### Neutral

- This ADR is expected to be **superseded** within ~6 months by an ADR that
  drops the Python pin once `node-window-manager` and `@hurdlegroup/robotjs`
  upstream `node-gyp` to v10+.

## Alternatives considered

- **Add `npm overrides` for `node-gyp` to ^10**: rejected because node-gyp's
  vendored gyp differs across major versions and may break the consumer's
  binding.gyp expectations.
- **Use `npm install --ignore-scripts` in Test workflow only**: would unblock
  `Test` but not `Build Verify`, and a future test that needs to mock or load
  a native module would silently break. Rejected for inconsistency.
- **Manually run `pip install setuptools` to provide `distutils` shim**: works
  but more brittle than just pinning Python 3.11.
- **Use a Docker image with Python 3.11 pre-baked**: overkill for a single
  package.

## Reversibility

When `node-window-manager` and `@hurdlegroup/robotjs` ship a release whose
direct `node-gyp` dep is `^10`, remove the `actions/setup-python@v5` step from
both `test.yml` and `build-verify.yml`. Mark this ADR as `Status: superseded
by ADR-XXXX`.
