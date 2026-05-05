# ADR-0010: OCR-driven banned-keyword detection via tesseract.js

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: anti-detection, ocr, circuit-breaker, dependencies

## Context

Spec §3.2 ("反封号") requires the engine to detect WeChat / 企业微信 popups
that signal an account in trouble (e.g. "账号异常", "冻结", "违规") and stop
the loop before the RPA layer accidentally clicks through them. The
`CircuitBreaker` already implements the matching half of this:

- Signal: `{ type: 'screenText'; text: string }`
- Config: `circuitBreaker.bannedKeywords: string[]` (defaults
  `['账号异常', '冻结', '违规']`)
- Trip reason: `'bannedKeyword'` carrying the matched keyword in its detail.

What was missing was the producer of `screenText`. Without OCR, the
breaker does eventually catch a stuck popup via its `screenshotFreezeMs`
guard (default 5 minutes) — the popup pixels don't change, so the
SHA-256 hash stays put and trips `'screenshotFreeze'`. Five minutes is
far too slow for a "封号关键词 → 立刻暂停" guarantee: by then the agent
might have sent dozens of replies into a screen that looks identical to
the human moderator on the other side.

The choice is therefore not "should we add OCR" but "which OCR
implementation, and how do we keep its cost off the hot path when the
user doesn't need it".

## Decision

### Library: `tesseract.js` (5.x)

We embed `tesseract.js` (latest 5.x) as a dependency. Tesseract is a
mature, BSD-licensed OCR engine; tesseract.js is a pure-JS / WASM
build that runs without any system-installed binaries. It supports both
Simplified Chinese (`chi_sim`) and English (`eng`) language packs, which
covers WeChat's surface today.

### Architecture: pluggable `OcrEngine` boundary

The engine talks to OCR through a narrow interface:

```ts
interface OcrEngine {
  extract(screenshot: Buffer): Promise<string>
  dispose(): Promise<void>
}
```

Two implementers ship with this PR:

- `TesseractOcrEngine` — production. Wraps a tesseract.js worker.
- `NullOcrEngine` — used in tests and as the default whenever
  `policy.ocr.enabled === false`. Returns `''`, costs nothing.

This is explicitly the "modular, swappable" design called out in the
spec: a future migration to a faster native backend (Windows ML,
macOS Vision framework, ONNX runtime, etc.) only needs a new
`OcrEngine` implementer. The engine, the policy, and the breaker stay
unchanged.

### Cost containment

Three knobs keep tesseract.js from dominating the engine's CPU/latency
profile:

1. **Disabled by default** (`OcrConfig.enabled = false`). The user
   opts in via the settings UI. This avoids forcing the ~10MB
   language-data download on users who don't need OCR.
2. **Sample-rate limiting.** The engine calls `extract()` at most once
   per `sampleIntervalMs` (default 30s). At ~200-500ms per scan, this
   bounds OCR to <2% CPU even on a hot loop.
3. **Lazy module import.** `TesseractOcrEngine` defers
   `await import('tesseract.js')` to the first `extract()` call.
   Constructing the engine for a disabled policy never pays the
   import cost; constructing it for an enabled policy never pays the
   download cost until the first scan actually fires.

### Failure handling

`extract()` is contractually no-throw: any tesseract failure
(initialization, language-data download timeout, recognition crash)
becomes an empty string and a single `warn`-level log line. The
breaker therefore never sees a partial / malformed `screenText` signal,
and a flaky OCR layer cannot take the engine loop down.

### Configuration

The new schema lives under `AntiDetectionConfig.ocr`:

```ts
ocr: {
  enabled: boolean // default false
  sampleIntervalMs: number // default 30_000, min 1_000
  language: string // default 'chi_sim+eng'
}
```

Round-trips through the existing `policy:set` IPC channel; no new IPC
surface.

### Engine lifecycle

OCR is constructed at `engine:start` time (one instance per engine
build, recreated on watchdog restarts). Switching `ocr.enabled` from
`false` to `true` while the engine is running does NOT swap the live
OCR instance — the user must restart the engine. The settings UI hint
calls this out explicitly. Hot-reload is tracked under Open Items.

## Consequences

### Positive

- **Banned-keyword popups are caught within ~30s** (one sample interval)
  instead of 5 minutes (`screenshotFreezeMs`).
- **Trip reason carries the matched keyword.** Already implemented in
  the breaker; OCR finally feeds it useful input.
- **Default-disabled means zero cost for users who don't need it.**
  No 10MB download, no 200-500ms latency tax, no hidden CPU.
- **Pluggable boundary.** A future native OCR backend is a
  drop-in replacement, not a rewrite of the engine.

### Negative

- **First-enable adds a ~10MB language-data download.** Tesseract.js
  fetches `chi_sim.traineddata` and `eng.traineddata` from a CDN on
  first worker creation. The progress is opaque to our UI; the user
  sees no feedback beyond "the first OCR scan is slower". Mitigation:
  the settings hint warns about this; the failure mode is graceful
  (`extract()` returns `''`, breaker stays idle).
- **200-500ms latency per scan.** Acceptable at 30s sampling; would
  be a problem at, say, 1s sampling. The schema's minimum
  `sampleIntervalMs` is 1s — high-frequency configurations will
  starve the loop.
- **Bundle size increase.** tesseract.js itself is ~150KB minified
  - a pinned WASM blob; language packs are downloaded at runtime so
    they don't bloat the installer.
- **JS / WASM is slower than native Tesseract.** A future native
  backend (see Open Items) will likely be 2-5× faster. Today the
  cross-platform-from-a-single-package convenience wins.

### Neutral

- **No new IPC channel.** Config rides the existing `policy:set`
  surface.

## Alternatives considered

- **`node-tesseract-ocr`** (Node binding to system Tesseract). Rejected:
  requires the user to install `tesseract` via Homebrew / Chocolatey /
  apt before our app works at all. Bad UX for the typical
  non-technical Windows user we're targeting.
- **Cloud OCR (Google Vision, Azure CV, etc.).** Rejected: adds
  per-scan latency over the network, costs money, requires a separate
  credential, and ships every screenshot to a third party — exactly
  the kind of data exposure the user enabled "反封号" mode to avoid.
- **Image diff against known popup templates.** Rejected: brittle
  (requires per-WeChat-version maintenance), can't match arbitrary
  banned-keyword text, and would still need the user to enumerate
  templates per language / theme.
- **Run OCR on every loop.** Rejected: at 200-500ms per scan and a
  3-5s polling cadence, OCR would dominate CPU and could starve the
  rest of the loop.
- **Run OCR in a worker thread.** Considered. tesseract.js already
  uses an internal worker (a Node `Worker` under the hood); spawning
  another worker layer on top would buy nothing. Revisit if a future
  native backend is synchronous on the main thread.

## Open items

- **Hot-reload of OCR config without engine restart.** Currently
  switching `ocr.enabled` from false → true requires a restart for
  the engine to pick up the new instance. Plumbing the OCR engine
  through `policy.updateConfig` (or building a small OCR registry the
  engine can consult lazily) would close this. Deferred.
- **Per-scenario language hints.** WeChat is `chi_sim+eng`; 飞书 is
  often pure `eng`; future B-end scenarios may want `chi_tra`. The
  config is currently global. A per-`AppType` override slots into the
  scenario refactor planned for Phase 4 / Phase 5.
- **Native backend.** Once we have a stable `OcrEngine` interface and
  a sense of OCR-feature usage, evaluate a native backend
  (Windows ML / Vision Framework / ONNX). Bonus: native backends
  don't require the 10MB download.
- **OCR latency / accuracy telemetry.** No metrics today. Worth
  adding once we have something to compare against (e.g. a future
  native backend).
