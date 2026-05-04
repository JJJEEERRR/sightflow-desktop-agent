# Phase 0 — Engineering Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a stable engineering baseline (test framework, CI, git hooks, ADR scaffold) on top of the SightFlow Desktop Agent fork, without touching any business logic in `src/`.

**Architecture:** Add tooling layers around the existing Electron/React/TS codebase. Vitest with two projects (`node` for `main`/`preload`/`core`, `jsdom` for `renderer`). GitHub Actions with three jobs: lint+typecheck (Linux), test (Windows+macOS matrix), build-verify (Windows+macOS). Husky pre-commit hooks run lint-staged. Commitlint enforces Conventional Commits.

**Tech Stack:**

- Vitest 1.6+ (with `@vitest/coverage-v8` and `vite-tsconfig-paths`)
- Husky 9 + lint-staged 15
- @commitlint/cli + @commitlint/config-conventional
- GitHub Actions
- ADR Markdown template (no tooling)

**Spec reference:** `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md` §6 Phase 0 + §3.8 + §3.9

---

## Pre-flight (one-time setup, not a TDD task)

The implementer is assumed to have a working clone of the fork at the workspace root, on a feature branch:

```bash
# from the workspace root (currently empty)
git clone https://github.com/<YOUR-USERNAME>/sightflow-desktop-agent.git
cd sightflow-desktop-agent
git remote add upstream https://github.com/sightflow-dev/sightflow-desktop-agent.git
git fetch upstream
git checkout -b chore/phase-0-engineering-baseline upstream/main
npm install
npm run dev   # smoke-check the upstream baseline still works
```

After Pre-flight, every Task below assumes `cwd` is the cloned repo root.

> **NOTE for the implementer:** if `npm install` fails at `postinstall` (`patch-package` step), check `patches/` directory and Node version. The repo currently uses `electron 39.2.6`; Node 20 LTS is recommended. **Do not** change Electron or robotjs versions in this plan; that is out of scope for Phase 0.

---

## File Structure (what this plan creates / modifies)

**Created files:**

- `.nvmrc` — Node version lock
- `.env.example` — non-secret config template
- `vitest.config.ts` — Vitest config with two projects
- `tests/smoke.test.ts` — single trivial test that proves Vitest runs
- `tests/setup.node.ts` — Node-side test setup (placeholder, empty)
- `tests/setup.jsdom.ts` — jsdom-side test setup (placeholder, empty)
- `.husky/pre-commit` — pre-commit hook running lint-staged
- `.husky/commit-msg` — commit-msg hook running commitlint
- `commitlint.config.js` — commitlint config (extends conventional)
- `.lintstagedrc.json` — lint-staged config
- `.github/workflows/lint-typecheck.yml` — CI workflow
- `.github/workflows/test.yml` — CI workflow (matrix)
- `.github/workflows/build-verify.yml` — CI workflow (matrix)
- `.github/dependabot.yml` — keep deps watched but only minor/patch PRs
- `docs/adr/template.md` — ADR template
- `docs/adr/0001-use-vitest-for-testing.md` — first ADR
- `docs/adr/0002-keep-robotjs-with-patch-package.md` — second ADR
- `docs/CONTRIBUTING.md` — minimal contribution guide
- `docs/architecture.md` — placeholder, will be filled in Phase 6

**Modified files:**

- `package.json` — add devDependencies, add scripts (`test`, `test:coverage`, `test:watch`, `prepare`)
- `.gitignore` — add `coverage/` and `.env`
- `README.md` — append a small "Development" section pointing to CONTRIBUTING.md

**Untouched in this phase:**

- `src/**/*` — zero changes
- `electron-builder.yml` — zero changes
- `electron.vite.config.ts` — zero changes
- `tsconfig*.json` — zero changes (keep existing TS config)
- `eslint.config.mjs` — zero changes (keep existing rules)
- `.prettierrc.yaml`, `.prettierignore`, `.editorconfig` — zero changes

---

## Task 1: Lock Node version with `.nvmrc`

**Files:**

- Create: `.nvmrc`

**Why:** so contributors and CI all use the same Node, reducing native-module rebuild surprises (robotjs).

- [ ] **Step 1: Verify currently working Node version**

Run: `node --version`
Expected: a version like `v20.x.y` or `v22.x.y`. **Record the major** (`20` or `22`).

- [ ] **Step 2: Create `.nvmrc`**

Pick `20` if `node --version` reported `v20.x` and `npm install && npm run build` works. Otherwise pick `22`. The file content is just the major version on a single line.

For Node 20 (recommended default):

```
20
```

- [ ] **Step 3: Verify by reinstalling cleanly**

Run:

```bash
rm -rf node_modules
npm ci
npm run typecheck
```

Expected: typecheck passes (does not change behavior, just confirms node version is fine).

- [ ] **Step 4: Commit**

```bash
git add .nvmrc
git commit -m "chore: lock Node version with .nvmrc"
```

---

## Task 2: Install Vitest and write a smoke test that fails first

**Files:**

- Modify: `package.json` — add devDependencies and `test` script
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts`
- Create: `tests/setup.node.ts`
- Create: `tests/setup.jsdom.ts`

- [ ] **Step 1: Write the failing smoke test FIRST**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

describe('vitest smoke', () => {
  it('runs in node environment by default', () => {
    expect(typeof process).toBe('object')
    expect(process.versions.node).toBeTruthy()
  })

  it('does basic arithmetic to prove the runner works', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Create empty setup files so Vitest config can reference them (they will be filled in later phases):

`tests/setup.node.ts`:

```ts
// Node-environment test setup. Intentionally empty for Phase 0.
export {}
```

`tests/setup.jsdom.ts`:

```ts
// jsdom-environment test setup. Intentionally empty for Phase 0.
export {}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: `npx` either errors that `vitest` is not found, or it tries to install on demand and fails because there is no config. **This is the "fail first" state**.

- [ ] **Step 3: Install Vitest and add scripts**

Run:

```bash
npm install --save-dev vitest@^1.6.0 @vitest/coverage-v8@^1.6.0 vite-tsconfig-paths@^4.3.2 jsdom@^24.0.0 @types/jsdom@^21.1.7
```

Edit `package.json` and ADD these script entries (do not remove existing scripts). The `scripts` section must contain:

```json
{
  "scripts": {
    "format": "prettier --write .",
    "lint": "eslint --cache .",
    "typecheck:node": "tsc --noEmit -p tsconfig.node.json --composite false",
    "typecheck:web": "tsc --noEmit -p tsconfig.web.json --composite false",
    "typecheck": "npm run typecheck:node && npm run typecheck:web",
    "start": "electron-vite preview",
    "dev": "node scripts/dev-launch.mjs",
    "dev:test-screenshot": "electron-vite build && cross-env TEST_MODE=screenshot electron ./out/main/test-cli.js",
    "dev:test-reply": "electron-vite build && cross-env TEST_MODE=reply electron ./out/main/test-cli.js",
    "dev:test-switch": "electron-vite build && cross-env TEST_MODE=switch electron ./out/main/test-cli.js",
    "build": "npm run typecheck && electron-vite build",
    "postinstall": "patch-package && electron-builder install-app-deps",
    "build:unpack": "npm run build && electron-builder --dir",
    "build:win": "npm run build && electron-builder --win",
    "build:mac": "electron-vite build && electron-builder --mac",
    "build:linux": "electron-vite build && electron-builder --linux",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage"
  }
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.{test,spec}.ts',
            'src/preload/**/*.{test,spec}.ts',
            'src/core/**/*.{test,spec}.ts',
            'tests/**/*.{test,spec}.ts'
          ],
          setupFiles: ['tests/setup.node.ts']
        }
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.jsdom.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/renderer/src/main.tsx',
        'src/renderer/src/env.d.ts',
        'src/preload/index.d.ts',
        'src/core/rpa/tests/**'
      ],
      thresholds: {
        lines: 0,
        statements: 0,
        functions: 0,
        branches: 0
      }
    }
  }
})
```

> The thresholds are 0 in Phase 0 by design — covered logic doesn't exist yet. Phase 2 onwards will raise this to 70 for `core/`.

- [ ] **Step 5: Run the smoke test, expect it to PASS now**

Run: `npm test`
Expected: green output, "2 passed".

- [ ] **Step 6: Run coverage to confirm reporter works**

Run: `npm run test:coverage`
Expected: green, prints a coverage table (mostly empty), creates `coverage/` directory.

- [ ] **Step 7: Update `.gitignore`**

Append to `.gitignore`:

```
coverage/
.env
.env.local
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/ .gitignore
git commit -m "test: add vitest with node+jsdom projects and smoke test"
```

---

## Task 3: Add `.env.example`

**Files:**

- Create: `.env.example`

**Why:** documents non-secret runtime env knobs in source control so contributors know what's overridable.

- [ ] **Step 1: Create the file with all currently-known env vars**

Search the codebase first to confirm which env vars exist:

Run: `grep -rn "process.env" src/ scripts/ | grep -v ".d.ts"`
Expected: shows references to `TEST_MODE` (in `src/main/test-cli.ts` based on `package.json` scripts) and `ELECTRON_RENDERER_URL` (Electron-vite built-in, not user-facing).

Create `.env.example`:

```bash
# SightFlow Desktop Agent — non-secret runtime configuration
#
# Copy this file to `.env` and edit. `.env` is gitignored and never committed.
# All values shown here are defaults; remove a line to inherit the default.

# ---- Test/Debug ----
# When set, runs the corresponding manual smoke script via `npm run dev:test-*`.
# Valid values: screenshot | reply | switch
# TEST_MODE=

# ---- Logging ----
# Override default log level. Valid: trace | debug | info | warn | error
# LOG_LEVEL=info

# ---- AI Provider override (for development testing only) ----
# Production app reads provider config from app settings UI, NOT from env.
# These vars are only consulted by manual CLI test scripts under src/core/rpa/tests/.
# DEV_AI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
# DEV_AI_MODEL=doubao-seed-2-0-lite-260215
# DEV_AI_API_KEY=
```

- [ ] **Step 2: Verify `.env` is gitignored**

Run: `git check-ignore -v .env`
Expected: prints `.gitignore:N:.env  .env` (proving the rule from Task 2 step 7 is active).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "chore: add .env.example documenting non-secret runtime config"
```

---

## Task 4: Install Husky and add pre-commit hook (lint-staged)

**Files:**

- Modify: `package.json` — add `prepare` script, add devDependencies
- Create: `.lintstagedrc.json`
- Create: `.husky/pre-commit`

- [ ] **Step 1: Install husky and lint-staged**

Run:

```bash
npm install --save-dev husky@^9.1.6 lint-staged@^15.2.10
```

- [ ] **Step 2: Add `prepare` script and run it**

Edit `package.json` `scripts` to ADD:

```json
{
  "scripts": {
    "prepare": "husky || true"
  }
}
```

> The `|| true` prevents `prepare` from failing in CI environments where `.git/` is absent (e.g., when installing into a docker layer that copied only `package.json`).

Run: `npm run prepare`
Expected: a `.husky/` directory is created.

- [ ] **Step 3: Create `.lintstagedrc.json`**

```json
{
  "*.{ts,tsx,js,jsx,mjs,cjs}": ["eslint --cache --fix", "prettier --write"],
  "*.{json,yml,yaml,md,html,css}": ["prettier --write"]
}
```

- [ ] **Step 4: Create `.husky/pre-commit`**

The file content should be a single line:

```
npx lint-staged
```

> Husky 9 no longer requires the shebang line. After creating the file, mark it executable. On Windows, git tracks the bit via `core.fileMode`; on macOS/Linux:

```bash
chmod +x .husky/pre-commit
```

- [ ] **Step 5: Verify the hook is wired up**

Make a trivial whitespace change to `README.md` (add and remove a blank line so git sees a change):

```bash
echo "" >> README.md
git add README.md
git commit -m "chore: test pre-commit hook (will revert)"
```

Expected: pre-commit runs lint-staged. If `README.md` was the only staged file, prettier should format it. The commit succeeds.

Now revert:

```bash
git reset --hard HEAD~1
```

- [ ] **Step 6: Commit the hook setup**

```bash
git add package.json package-lock.json .lintstagedrc.json .husky/pre-commit
git commit -m "chore: add husky pre-commit running lint-staged"
```

---

## Task 5: Install commitlint and add commit-msg hook

**Files:**

- Modify: `package.json` — add devDependencies
- Create: `commitlint.config.js`
- Create: `.husky/commit-msg`

- [ ] **Step 1: Install commitlint**

Run:

```bash
npm install --save-dev @commitlint/cli@^19.5.0 @commitlint/config-conventional@^19.5.0
```

- [ ] **Step 2: Create `commitlint.config.js`**

```js
/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0]
  }
}
```

> `subject-case` is disabled because Chinese subjects don't have casing; line-length rules are disabled to keep CJK commit messages friendly.

- [ ] **Step 3: Create `.husky/commit-msg`**

```
npx --no -- commitlint --edit $1
```

Mark executable on macOS/Linux:

```bash
chmod +x .husky/commit-msg
```

- [ ] **Step 4: Verify commitlint rejects an invalid commit message**

```bash
echo "" >> README.md
git add README.md
git commit -m "this is not a conventional commit message" || echo "REJECTED (expected)"
```

Expected: commit fails with commitlint error. The string `REJECTED (expected)` is printed.

Reset:

```bash
git checkout README.md
```

- [ ] **Step 5: Verify commitlint accepts a valid message**

```bash
echo "" >> README.md
git add README.md
git commit -m "chore: trigger commitlint check"
```

Expected: commit succeeds.

Revert:

```bash
git reset --hard HEAD~1
```

- [ ] **Step 6: Commit the commitlint setup**

```bash
git add package.json package-lock.json commitlint.config.js .husky/commit-msg
git commit -m "chore: add commitlint with conventional config"
```

---

## Task 6: GitHub Actions — lint+typecheck workflow

**Files:**

- Create: `.github/workflows/lint-typecheck.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Lint & Typecheck

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: lint-typecheck-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-typecheck:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci --ignore-scripts
        # `--ignore-scripts` skips `postinstall` (patch-package + electron-builder install-app-deps),
        # which would try to download Electron binaries we don't need for lint/typecheck.

      - name: Run patch-package only (skip electron-builder)
        run: npx patch-package
        # We still want patches applied so typecheck sees the patched code.

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck
```

- [ ] **Step 2: Commit and push the workflow**

```bash
git add .github/workflows/lint-typecheck.yml
git commit -m "ci: add lint and typecheck workflow"
git push -u origin chore/phase-0-engineering-baseline
```

- [ ] **Step 3: Verify the workflow runs green on GitHub**

Open `https://github.com/<YOUR-USERNAME>/sightflow-desktop-agent/actions`. The "Lint & Typecheck" run for the pushed branch must end green.

> If lint or typecheck fails, **do not** modify `eslint.config.mjs` or `tsconfig*.json` in this Phase 0 plan. Stop and report — those are upstream issues that need a separate fix or a `lint:upstream-baseline` allowlist decision.

---

## Task 7: GitHub Actions — test workflow (Windows + macOS matrix)

**Files:**

- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: test-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'

      - name: Install dependencies (with native rebuild)
        run: npm ci

      - name: Run tests with coverage
        run: npm run test:coverage

      - name: Upload coverage artifact
        if: matrix.os == 'macos-latest'
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
          retention-days: 7
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add test workflow with windows+macos matrix"
git push
```

- [ ] **Step 3: Verify both matrix jobs pass on GitHub**

Both `test (windows-latest)` and `test (macos-latest)` must end green. The smoke test from Task 2 is the only test running, so they should pass within a few minutes after `npm ci`.

> If `npm ci` fails on Windows because of robotjs native build, that is an existing upstream issue. Stop and write a quick ADR `0003-robotjs-windows-build.md` (template in Task 11) documenting the failure and how to install build tools (e.g. `npm install --global windows-build-tools` is deprecated; modern is to install Visual Studio Build Tools manually). Then resume.

---

## Task 8: GitHub Actions — build-verify workflow (Windows + macOS)

**Files:**

- Create: `.github/workflows/build-verify.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Build Verify

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: build-verify-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-verify:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            build-script: 'build:win'
          - os: macos-latest
            build-script: 'build:mac'
    runs-on: ${{ matrix.os }}
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build (no installer)
        # We invoke electron-builder via electron-vite without distributable target
        # to verify the codebase compiles. We do NOT publish artifacts.
        run: npm run build:unpack

      - name: List dist artifacts
        if: always()
        shell: bash
        run: |
          ls -la dist/ || echo "no dist directory"
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/build-verify.yml
git commit -m "ci: add build-verify workflow for win+mac"
git push
```

- [ ] **Step 3: Verify both matrix jobs pass**

Both must end green. `build:unpack` runs the full build but skips installer creation, so it's strictly faster than `build:win` / `build:mac` and uses no signing certs.

> Both jobs may take 10-25 minutes due to native module compilation. That's expected. Acceptable as long as they're green.

---

## Task 9: Add Dependabot config

**Files:**

- Create: `.github/dependabot.yml`

**Why:** stay on top of security patches without daily noise. Patch+minor only; major bumps will be manually reviewed.

- [ ] **Step 1: Create the file**

```yaml
version: 2
updates:
  - package-ecosystem: 'npm'
    directory: '/'
    schedule:
      interval: 'weekly'
      day: 'monday'
    open-pull-requests-limit: 5
    versioning-strategy: 'increase'
    ignore:
      - dependency-name: 'electron'
        update-types: ['version-update:semver-major']
      - dependency-name: '@hurdlegroup/robotjs'
        update-types: ['version-update:semver-major']
      - dependency-name: 'react'
        update-types: ['version-update:semver-major']
      - dependency-name: 'react-dom'
        update-types: ['version-update:semver-major']
    labels:
      - 'dependencies'

  - package-ecosystem: 'github-actions'
    directory: '/'
    schedule:
      interval: 'monthly'
    labels:
      - 'dependencies'
      - 'ci'
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/dependabot.yml
git commit -m "ci: add dependabot for weekly minor/patch updates"
git push
```

> Dependabot will not produce any PR until a few hours after merge; nothing to verify locally beyond the file syntax.

---

## Task 10: Add ADR template and the first two ADRs

**Files:**

- Create: `docs/adr/template.md`
- Create: `docs/adr/0001-use-vitest-for-testing.md`
- Create: `docs/adr/0002-keep-robotjs-with-patch-package.md`

- [ ] **Step 1: Create `docs/adr/template.md`**

```markdown
# ADR-NNNN: <Decision title>

- Status: proposed | accepted | superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: <names or roles>
- Tags: <area, e.g. testing, security, ai>

## Context

What is the issue we're seeing that is motivating this decision or change?

## Decision

What is the change that we're proposing or have agreed to implement?

## Consequences

What becomes easier or more difficult to do because of this change?

### Positive

- ...

### Negative

- ...

### Neutral

- ...

## Alternatives considered

- **Alternative A:** ...
- **Alternative B:** ...
```

- [ ] **Step 2: Create `docs/adr/0001-use-vitest-for-testing.md`**

```markdown
# ADR-0001: Use Vitest as the test framework

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: testing, infrastructure

## Context

The forked codebase has no automated tests, only four manual CLI smoke scripts under
`src/core/rpa/tests/`. Phase 0 needs a test framework that:

1. Works in both Node (main/preload/core) and DOM (renderer) environments.
2. Plays well with TypeScript and the existing Vite/electron-vite build chain.
3. Has fast watch mode for TDD.
4. Has built-in coverage support without extra Babel/transform dance.

## Decision

Adopt **Vitest** with two test projects:

- `node` project covers `src/main/`, `src/preload/`, `src/core/`.
- `jsdom` project covers `src/renderer/` (React).

Coverage uses V8 provider via `@vitest/coverage-v8`. Path aliases come from
`vite-tsconfig-paths`.

## Consequences

### Positive

- Single tool, single config for all surfaces.
- Native ESM and TS support; no Babel needed.
- Vite ecosystem is already in use (electron-vite).
- Fast.

### Negative

- Vitest does not run Electron itself; renderer tests use jsdom, not the real
  Chromium runtime. End-to-end Electron testing is explicitly out of scope
  (see spec §3.8). Real-device smoke testing remains via existing
  `core/rpa/tests/*.ts` manual scripts.
- Vitest 1.6 is the minimum version; older versions don't support the
  `projects` array shape used here.

### Neutral

- Coverage thresholds are 0 in Phase 0; they will be raised to ≥70% for `core/`
  in Phase 2 onwards as real tests appear.

## Alternatives considered

- **Jest:** mature, well-known, but the TS+Vite+Electron stack works less
  smoothly. Slower, larger config surface.
- **Node built-in `node:test`:** lightest weight, but no UI test environment
  and no DOM matchers. Would need a second tool for renderer tests.
- **Playwright Test:** great for E2E; overkill for unit/integration. We will
  consider it later only if real Electron-runtime tests become necessary.
```

- [ ] **Step 3: Create `docs/adr/0002-keep-robotjs-with-patch-package.md`**

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/
git commit -m "docs: add ADR template and first two architecture decisions"
git push
```

---

## Task 11: Add minimal CONTRIBUTING.md and architecture.md placeholder

**Files:**

- Create: `docs/CONTRIBUTING.md`
- Create: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Create `docs/CONTRIBUTING.md`**

````markdown
# Contributing

## Prerequisites

- Node.js (version pinned in `.nvmrc`). Use `nvm use` to switch.
- Platform-specific build tools for native modules (see below).

### Native build tools

- **Windows:** Visual Studio Build Tools 2022 with the "Desktop development with C++" workload.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).

## Setup

```bash
git clone https://github.com/<YOUR-FORK>/sightflow-desktop-agent.git
cd sightflow-desktop-agent
nvm use
npm install
npm run dev
```

## Development workflow

1. Create a feature branch off `main`:
   `git checkout -b feat/your-feature`
2. Make changes. The pre-commit hook will run lint+format on staged files.
3. Add tests in `tests/` or co-located as `*.test.ts(x)` next to the file.
4. Run `npm test` to make sure everything passes.
5. Run `npm run typecheck` if you changed types.
6. Commit using **Conventional Commits** (commitlint will enforce):
   - `feat: add X`
   - `fix: correct Y`
   - `chore: update Z`
   - `docs: explain W`
   - `test: cover V`
   - `refactor: simplify U`
   - `ci: tweak T`
7. Push and open a PR against `main`.

## Tests

- `npm test` — run all tests once.
- `npm run test:watch` — watch mode.
- `npm run test:coverage` — generate coverage report.

## Code style

- ESLint + Prettier. Run `npm run lint` and `npm run format` if needed.
- TypeScript strict mode (do not weaken).
- No `any` unless commented with the reason.

## Architecture

See `docs/architecture.md` and `docs/adr/`.

## Manual smoke tests (RPA)

The following scripts run against a real machine (will move your mouse,
type into the focused window). Use a clean VM or be careful:

```bash
npm run dev:test-screenshot
npm run dev:test-reply
npm run dev:test-switch
```
````

- [ ] **Step 2: Create `docs/architecture.md` placeholder**

```markdown
# Architecture

This document is a placeholder. The full architecture description will be
written in Phase 6 of the foundation hardening work, once the runtime/brain/
anti-detection layers stabilize.

For the design intent, see:

- `docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md`

For specific decisions, see:

- `docs/adr/`
```

- [ ] **Step 3: Append a "Development" section to `README.md`**

Find the existing "## 开发环境推荐配置" section in `README.md` and ADD a new section after it. Do NOT alter existing content. The new content:

```markdown
## 开发与贡献 (Development & Contributing)

请参阅 [CONTRIBUTING](docs/CONTRIBUTING.md) 了解如何搭建开发环境、运行测试和提交代码。

构架与重要决策：

- 设计文档：[`docs/superpowers/specs/`](docs/superpowers/specs/)
- 架构决策记录：[`docs/adr/`](docs/adr/)
```

- [ ] **Step 4: Commit**

```bash
git add docs/CONTRIBUTING.md docs/architecture.md README.md
git commit -m "docs: add CONTRIBUTING, architecture placeholder, and dev section in README"
git push
```

---

## Task 12: Final integration check — full local + CI green

**Files:** none

This task does no edits; it only verifies the whole Phase 0 stack works together.

- [ ] **Step 1: Clean re-install locally**

```bash
rm -rf node_modules
npm ci
```

Expected: completes without errors.

- [ ] **Step 2: Run the full local quality bar**

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
```

Expected: all four pass green.

- [ ] **Step 3: Sanity-check the husky hooks still trigger**

```bash
echo "" >> README.md
git add README.md
git commit -m "this should fail commitlint"
```

Expected: commit-msg hook rejects.

```bash
git checkout README.md
```

- [ ] **Step 4: Confirm all CI workflows green on GitHub**

Open Actions tab. All three workflows (`Lint & Typecheck`, `Test`, `Build Verify`) on the latest commit of branch `chore/phase-0-engineering-baseline` must show green.

- [ ] **Step 5: Open the PR (do not merge yet)**

```bash
gh pr create \
  --base main \
  --head chore/phase-0-engineering-baseline \
  --title "chore(phase-0): engineering baseline" \
  --body "Implements Phase 0 of docs/superpowers/specs/2026-05-05-sightflow-foundation-design.md.

Adds:
- Vitest with node+jsdom projects + smoke test
- Husky pre-commit (lint-staged) and commit-msg (commitlint)
- GitHub Actions: lint+typecheck (Linux), test (Win+macOS), build-verify (Win+macOS)
- Dependabot config for weekly minor/patch updates
- ADR scaffold + first two ADRs
- CONTRIBUTING.md, architecture.md placeholder
- .nvmrc, .env.example

No \`src/\` changes. Existing \`npm run dev\` / \`build:win\` / \`build:mac\` continue to work."
```

> **Stop here. Do not merge.** This plan does not perform the merge — that's a human decision after PR review. The next plan (Phase 1) starts from a fresh branch off `main` after this PR is merged.

---

## Self-Review

(Performed by author against the spec — written here so the implementer can see the trail.)

**Spec coverage check:**

| Spec §6 Phase 0 line item                                    | Implemented in                                    |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Vitest + 覆盖率配置                                          | Task 2                                            |
| GitHub Actions 三 job (lint+typecheck / test / build-verify) | Tasks 6, 7, 8                                     |
| husky + lint-staged                                          | Task 4                                            |
| commitlint                                                   | Task 5                                            |
| .nvmrc                                                       | Task 1                                            |
| .env.example                                                 | Task 3                                            |
| 基础测试骨架 (管道跑通)                                      | Task 2 (smoke test) + Task 12 (integration check) |

| Spec §3.8 line item          | Implemented in                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| vitest + @vitest/coverage-v8 | Task 2                                                                                                     |
| 覆盖率目标 core/ ≥ 70%       | NOT enforced in Phase 0 (threshold = 0). Will tighten in Phase 2+. Documented in Task 2 step 4 + ADR-0001. |
| 单元/集成测试                | Out of scope for Phase 0 (no real logic to cover yet).                                                     |
| E2E 暂不做                   | Confirmed in ADR-0001.                                                                                     |

| Spec §3.9 line item               | Implemented in                   |
| --------------------------------- | -------------------------------- |
| GitHub Actions 三 job             | Tasks 6-8                        |
| husky + lint-staged               | Task 4                           |
| commitlint + conventional commits | Task 5                           |
| .nvmrc Node 20 LTS                | Task 1                           |
| .env.example                      | Task 3                           |
| docs/adr/ 重要架构决策            | Tasks 10, 11 (template + 2 ADRs) |

**Placeholder scan:**

- No "TBD", "TODO", "implement later" found.
- All commands shown verbatim.
- All file contents shown in full.
- One reference to "Phase 6 will fill architecture.md" — that is intentional cross-plan reference, not a placeholder for this plan.

**Type/name consistency:**

- Script name `test` and `test:coverage` referenced consistently in Task 2 (definition), Task 7 (CI), and Task 12 (verification).
- Branch name `chore/phase-0-engineering-baseline` consistent in Pre-flight, Task 6, and Task 12.
- Workflow file names match between Tasks 6, 7, 8 and Task 12 verification.
- ADR numbers `0001`, `0002` match between Task 10 file names and Task 10 cross-references.

No issues found.
