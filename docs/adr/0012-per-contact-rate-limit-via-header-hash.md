# ADR-0012: Per-contact rate limit via header-strip hash

- Status: accepted
- Date: 2026-05-05
- Deciders: project owner
- Tags: architecture, policy, scenarios, rate-limiting, privacy

## Context

The `RateLimiter` has supported per-contact daily caps since Phase 3:
`check(contactId?)` and `recordSend(contactId?)` enforce a
`perContactPerDay` cap (default 20) when given a contact id. The
schema already exposes `perContactPerDay` and the renderer's
`AntiDetectionSettings` UI surfaces it.

What was missing was the _plumbing_: nobody passed a `contactId`.

- `Engine.processCurrentChat()` called `policy.beforeReply()` with no
  context, so `RateLimiter.check()` saw `contactId === undefined` and
  the per-contact gate skipped.
- `WechatScenario.execute()` called
  `policy.afterAction({ type: 'reply', text }, …)` with no
  `contactId`, so `RateLimiter.recordSend(undefined)` only ever
  incremented the global hourly bucket.

The result: the policy machinery for per-contact caps was inert. We
need a way to identify "who is this chat with right now" without
introducing per-tick OCR cost or per-tick VLM API spend.

## Decision

Introduce an _optional_ `Scenario.getContactId(screenshot)` method
and an _optional_ `ScenarioHelpers.contactId` field. The engine calls
`getContactId` once per tick after taking the screenshot, threads
the result into `policy.beforeReply({ contactId })`, and includes it
in `ScenarioHelpers` so the scenario forwards it into
`policy.afterAction(...)`.

`WechatScenario.getContactId` derives a stable, opaque identifier by
hashing a deterministic top-strip region of the screenshot:

```ts
async getContactId(screenshot: string): Promise<string | undefined> {
  try {
    const buffer = screenshotToBuffer(screenshot)
    const img = await Jimp.read(buffer)
    const headerHeight = Math.min(80, img.bitmap.height)
    img.crop({ x: 0, y: 0, w: img.bitmap.width, h: headerHeight })
    const hash = createHash('sha256').update(img.bitmap.data).digest('hex')
    return hash.slice(0, 16)
  } catch (err) {
    this.log.warn('getContactId failed', { err })
    return undefined
  }
}
```

The chat header band (top of the chat-main-area) shows the contact's
name + avatar + sometimes status indicators. Hashing the first 80
pixels of the screenshot height (full width) gives us:

- **Stability** for the same contact across ticks — the header
  doesn't change between messages within the same chat.
- **Uniqueness** between contacts — different name + avatar = different
  pixels = different SHA-256.
- **Cheap** — ~1-3 ms for SHA-256 of an ~80×width pixel buffer.
- **Privacy** — the hash is opaque; the contact's display name is
  never echoed in the id.

`jimp` is already a project dependency (used by
`src/core/rpa/screenshot-utils.ts` and `src/core/rpa/has-unread.ts`),
so no new dep is added.

### Engine ordering change

Pre-ADR-0012 the engine ran the policy gate _before_ taking the
screenshot. To plumb `contactId` into `beforeReply()` we had to flip
the order: screenshot first, then `getContactId`, then gate. This
costs one extra screenshot per blocked tick — acceptable because
`scenario.screenshot()` is already cheap (cached) and a blocked
tick is rare on the steady-state path. Two existing tests that
asserted "no screenshot when gate denies" were updated to assert
"no `sendMessage` / `setChatBaseline` / `brain.decide` when gate
denies" instead — the materially-correct invariant remains.

## Consequences

### Positive

- **Per-contact daily caps now work end-to-end.** A user who keeps
  pinging the agent will hit the per-contact cap (default 20/day)
  and get a soft block; sends to other contacts are unaffected.
- **No new dependency.** `jimp` is already in `package.json`.
- **Privacy-preserving.** Contact display names never leave the
  scenario layer; the engine and policy see only opaque 16-char
  hex strings.
- **CPU cost is negligible.** ~1-3 ms per tick for the SHA-256 of
  an 80×width pixel buffer.
- **Memory cost is the existing rate-limiter storage.** Per-contact
  counters are persisted by the existing storage layer; no new
  storage was added.
- **Optional surface.** Scenarios that don't implement
  `getContactId` (or implementations that return `undefined`) keep
  working — per-contact gates simply skip and global gates still
  apply. Backward-compatible with PR #13's locked Scenario surface.

### Negative

- **Header pixel noise.** Online/offline status dots and timestamp
  redraws within the header strip will occasionally cause the same
  contact to hash to two different ids inside a 24h window —
  effectively allowing 1-2 extra "first sends" before the cap
  kicks in. Mitigation: deferred (see Open Items).
- **Screenshot now happens before the policy gate.** A blocked tick
  pays for one screenshot it then discards. The cost is bounded
  by the gate's own retry cadence (`waitMs` from the rate-limiter)
  and is not in any tight loop.
- **Header strip is heuristic.** The first 80 px tall × full width
  region works for the current WeChat layout; a future WeChat UI
  refresh could move the contact header out of that band, at which
  point all contact ids globally rotate (per-contact counters
  effectively reset). Acceptable: rate limiting is per-day, not
  per-eternity, and we'll notice the next time we update the
  layout descriptors.

### Neutral

- **No IPC contract changes.** `contactId` lives entirely inside
  the engine + scenario + policy boundary; renderer is untouched.
- **No main-process changes.** The engine constructor signature is
  unchanged; the scenario itself does the lifting.

## Alternatives considered

- **OCR-extracted contact name.** Rejected for now: depends on the
  optional OCR engine being enabled, and Tesseract.js adds 200-500
  ms per tick which we explicitly avoid in the steady-state loop.
  Once OCR is broadly enabled, swapping the implementation behind
  `getContactId` is a one-method change.
- **VLM call to identify the contact.** Rejected: per-tick VLM
  API spend is incompatible with the daily-cap budget itself. A
  rate-limit identity lookup that costs $$$ per identification
  defeats the purpose.
- **Whole-screenshot hash.** Rejected: the chat-main-area pixels
  change every time a new message lands, so a whole-screenshot
  hash rotates every tick within the same chat. The per-contact
  gate would degrade into a global gate plus extra storage write
  overhead.
- **Hash a window-manager-derived contact identifier.** Rejected:
  WeChat doesn't expose stable per-chat handles via the platform
  window APIs we're already using; we'd need new RPA primitives.

## Open items

- **Tighten the header strip.** The current 80 px × full width
  band includes the timestamp / online-dot pixels that cause
  occasional id rotation. A future iteration can crop tighter
  around just the contact-name region (and optionally the
  avatar) once we measure how much that reduces noise on real
  layouts.
- **OCR-based identity once OCR is opt-out.** The robustness
  story improves significantly if we extract the contact name
  via OCR and hash _that_ string. Cheap once OCR runs anyway.
- **Cross-app generalisation.** When the second `Scenario` lands
  (`FeishuScenario` etc.) we'll know which parts of this design
  are WeChat-specific (the 80 px header heuristic) vs. shared
  (the SHA-256 truncation, the optional-method shape). The
  shared bits can move into a helper under
  `src/core/scenarios/_shared/`.
