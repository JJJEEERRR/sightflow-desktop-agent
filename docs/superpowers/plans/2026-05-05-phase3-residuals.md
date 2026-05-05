# Phase 3 残留 Implementation Plan

> Cleanup PR — collapses three deferred items from the Phase 3 plan. Two
> independent workstreams (renderer UI + engine integration) are run in
> parallel. OCR / per-contact rate limiting / engine signal for OCR remain
> deferred (separate larger PRs).

**Goal:** Close the three Phase 3 deferred items that don't depend on Phase 4 or OCR — engine emits screenshotHash signal so the existing freeze-detection logic actually fires, the inline polling sleeps move to Humanizer for unified pacing, and a renderer Settings page exposes the policy config the IPC handlers already accept.

**Architecture:** No new modules. Each task is a small change in an existing area: `engine.ts` for A+C, `App.tsx` + `i18n.ts` + `index.css` for B. zod parsing of the screenshotHash is reused from `core/policy/`.

**Tech Stack:** TypeScript, Node `crypto` for hashing, existing Humanizer / Policy / Engine / React / i18n.

---

## Tasks

### A. Engine emits screenshotHash signal (controller)

**Files:**

- Modify: `src/core/engine.ts` — in `processCurrentChat`, hash the screenshot string with SHA-256 and call `policy.observe({ type: 'screenshotHash', hash })` BEFORE `brain.decide`. The breaker's freeze detection compares against the previous hash and trips on `screenshotFreezeMs` of no change.
- Modify: `src/core/engine.test.ts` — add 1 test: with a stub policy, two ticks with the same screenshot value emit two `screenshotHash` observe calls with the same hash; two ticks with different screenshots emit different hashes.

**Implementation sketch:**

```ts
import { createHash } from 'node:crypto'

private hashScreenshot(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// in processCurrentChat, after `const screenshot = ...`:
this.policy?.observe({ type: 'screenshotHash', hash: this.hashScreenshot(screenshot) })
```

### C. Migrate `waitForNextUnread` sleeps to Humanizer (controller)

**Files:**

- Modify: `src/core/engine.ts` — replace the four ad-hoc `this.sleep(N + Math.random()*M)` calls inside `waitForNextUnread` with `await this.policy?.beforeAction({ type: 'click', coords: [...] })` for the click-related delays, and direct calls to `policy.beforeAction`/`afterAction` for the polling jitter sleeps (use `'click'` action so jitter applies). Where there is no policy, fall back to the existing `this.sleep` math (no behavior change).
- Modify: `src/core/engine.test.ts` — existing tests already hit `waitForNextUnread`; verify nothing breaks. Add 1 test: with a stub policy, the click-related actions in `waitForNextUnread` go through `policy.beforeAction`.

### B. Anti-detection settings UI page (subagent)

**Files:**

- Modify: `src/renderer/src/App.tsx` — add a new `'antiDetection'` value to the `View` type union; add a button in the settings page to open the new view; wire the back button.
- Create: `src/renderer/src/components/AntiDetectionSettings.tsx` — the new page. Reads via `policy:get`, posts patches via `policy:set`, shows a status snapshot via `policy:snapshot`. Single-page layout with four sections (Humanizer / RateLimiter / Schedule / CircuitBreaker), preset buttons (保守/平衡/激进), and a "Reset breaker" button when the breaker is tripped.
- Modify: `src/renderer/src/i18n.ts` — add `policy.*` keys (zh + en).
- Modify: `src/renderer/src/index.css` — minor styles for the new page (reuse existing card/form classes wherever possible).
- Create: `src/renderer/src/components/AntiDetectionSettings.test.tsx` — unit tests using `FakeElectron` (same pattern as `DiagnosticsPanel.test.tsx`).

The renderer cannot import from `src/core/policy/` (vite would inline zod). The component types `AntiDetectionConfig` and `PolicySnapshot` should mirror only the fields the UI uses; an explicit comment notes the contract.

## Quality gates

```
npm run lint
npm run typecheck
npx vitest run          # 350 baseline, target ≥ 360
npm run build
```

## Out of scope (still deferred)

- OCR pipeline + engine emission of `screenText` signal — separate PR.
- Per-contact rate limit in engine — depends on Phase 4 Scenarios.
- Migrating the polling-loop micro-sleeps in `waitForNextUnread` is partially in scope (only the click-adjacent ones); the 3-5s polling-interval sleep stays as `this.sleep` because it's a pacing element, not an action delay.
