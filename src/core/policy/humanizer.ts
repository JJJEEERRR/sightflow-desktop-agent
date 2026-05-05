/**
 * Humanizer — emits randomised micro-delays, click jitter, and typo-prone
 * typing plans so RPA-driven actions look less like a bot.
 *
 * The whole module is built around an injectable `HumanizerClock` so tests
 * stay deterministic: `sleep` is a side-effect we capture, `random()` is a
 * value we control. Real production code goes through Node's `setTimeout`
 * and `Math.random` via `realClock`.
 *
 * Config is held by-value and shallow-replaced on `updateConfig` so callers
 * can hot-reload anti-detection settings without rebuilding the engine.
 */

import { type HumanizerConfig } from './config'
import { getLogger } from '../observability'

export interface HumanizerClock {
  sleep(ms: number): Promise<void>
  random(): number
}

export type TypingStep =
  | { type: 'type'; ms: number; charIndex: number }
  | { type: 'pause'; ms: number; reason: 'punctuation' | 'long' | 'read' }
  | { type: 'typo'; ms: number; charIndex: number; wrongChar: string }

export interface HumanizerOptions {
  config: HumanizerConfig
  clock?: HumanizerClock
}

const realClock: HumanizerClock = {
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    }),
  random: () => Math.random()
}

/**
 * Punctuation that triggers a "thinking" pause after typing. Includes the
 * common CJK marks plus their ASCII counterparts so mixed-script text reads
 * naturally.
 */
const PUNCTUATION = new Set<string>([
  '。',
  '，',
  '、',
  '！',
  '？',
  '：',
  '；',
  '.',
  ',',
  '!',
  '?',
  ':',
  ';'
])

/** Pool of stand-in "wrong" characters used when emitting a typo step. */
const TYPO_POOL = 'abcdefghijklmnopqrstuvwxyz'

export class Humanizer {
  private config: HumanizerConfig
  private readonly clock: HumanizerClock
  private readonly log = getLogger('policy.humanizer')

  constructor(opts: HumanizerOptions) {
    this.config = { ...opts.config }
    this.clock = opts.clock ?? realClock
  }

  updateConfig(patch: Partial<HumanizerConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  async preActionDelay(): Promise<void> {
    if (!this.config.enabled) return
    await this.clock.sleep(this.sampleRange(this.config.preActionDelayMs))
  }

  async postActionDelay(): Promise<void> {
    if (!this.config.enabled) return
    await this.clock.sleep(this.sampleRange(this.config.postActionDelayMs))
  }

  async readDelay(): Promise<void> {
    if (!this.config.enabled) return
    await this.clock.sleep(this.sampleRange(this.config.readDelayMs))
  }

  async maybeLongPause(): Promise<void> {
    if (!this.config.enabled) return
    if (this.clock.random() >= this.config.longPauseProbability) return
    const ms = this.sampleRange(this.config.longPauseMs)
    this.log.debug('Long pause', { ms })
    await this.clock.sleep(ms)
  }

  jitterCoords(x: number, y: number): [number, number] {
    if (!this.config.enabled || this.config.clickJitterPx === 0) {
      return [x, y]
    }
    const j = this.config.clickJitterPx
    const dx = Math.round(-j + this.clock.random() * 2 * j)
    const dy = Math.round(-j + this.clock.random() * 2 * j)
    return [x + dx, y + dy]
  }

  /**
   * Returns a fresh async iterable of `TypingStep`s for `text`. Re-runnable:
   * each call to `typingPlan` (and each `[Symbol.asyncIterator]()` on the
   * returned object) starts an independent walk with its own random draws.
   */
  typingPlan(text: string): AsyncIterable<TypingStep> {
    // Capture `this` via an arrow factory rather than aliasing it; calling
    // `typingPlan` (and re-iterating the returned iterable) yields a fresh
    // generator each time.
    const factory = (): AsyncIterator<TypingStep> => this.runTypingPlan(text)
    return { [Symbol.asyncIterator]: factory }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async *runTypingPlan(text: string): AsyncGenerator<TypingStep> {
    this.log.debug('Typing plan start', { length: text.length })

    if (!this.config.enabled) {
      for (let i = 0; i < text.length; i++) {
        yield { type: 'type', ms: 0, charIndex: i }
      }
      return
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]

      // Long pause rolls only between characters, never before the first.
      if (i > 0 && this.clock.random() < this.config.longPauseProbability) {
        const ms = this.sampleRange(this.config.longPauseMs)
        this.log.debug('Long pause', { ms })
        yield { type: 'pause', ms, reason: 'long' }
      }

      // Per-char base inter-key delay sampled fresh from charsPerSecond.
      const baseMs = this.sampleTypingDelayMs()

      if (i > 0 && this.clock.random() < this.config.typoProbability) {
        const wrongChar = this.pickWrongChar(ch)
        yield { type: 'typo', ms: baseMs, charIndex: i, wrongChar }
      } else {
        yield { type: 'type', ms: baseMs, charIndex: i }
      }

      // Punctuation pause is keyed off the INTENDED character; when a typo
      // fires for a punctuation char we still emit the natural "pause to
      // think" step because the user-visible cadence is what matters.
      if (PUNCTUATION.has(ch)) {
        const pauseMs = this.sampleRange(this.config.punctuationPauseMs)
        yield { type: 'pause', ms: pauseMs, reason: 'punctuation' }
      }
    }
  }

  private sampleRange(range: readonly [number, number]): number {
    const [min, max] = range
    return min + this.clock.random() * (max - min)
  }

  private sampleTypingDelayMs(): number {
    const [minCps, maxCps] = this.config.charsPerSecond
    const cps = minCps + this.clock.random() * (maxCps - minCps)
    return 1000 / cps
  }

  /**
   * Pick a single placeholder "wrong" character that differs from `intended`.
   * Driven entirely by the injected clock so the choice is deterministic in
   * tests; falls back to the next pool entry when the draw collides with the
   * intended character.
   */
  private pickWrongChar(intended: string): string {
    const idx = Math.floor(this.clock.random() * TYPO_POOL.length) % TYPO_POOL.length
    const pick = TYPO_POOL[idx]
    if (pick === intended) {
      return TYPO_POOL[(idx + 1) % TYPO_POOL.length]
    }
    return pick
  }
}
