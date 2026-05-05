import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Humanizer, type HumanizerClock, type TypingStep } from './humanizer'
import { HumanizerConfigSchema, type HumanizerConfig } from './config'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

/**
 * Deterministic clock mirroring the FakeClock pattern used in
 * `src/core/runtime/watchdog.test.ts`. `sleep` only records the requested
 * duration (no real timers); `random` returns either a fixed value or, when
 * a queue is set, the next entry — letting tests script multi-draw flows.
 */
class FakeClock implements HumanizerClock {
  slept: number[] = []
  randomValue = 0.5
  randomQueue: number[] | null = null

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms)
  }

  random(): number {
    if (this.randomQueue && this.randomQueue.length > 0) {
      return this.randomQueue.shift() as number
    }
    return this.randomValue
  }

  totalSleptMs(): number {
    return this.slept.reduce((s, n) => s + n, 0)
  }
}

function makeConfig(overrides: Partial<HumanizerConfig> = {}): HumanizerConfig {
  return { ...HumanizerConfigSchema.parse({}), ...overrides }
}

async function collectSteps(iter: AsyncIterable<TypingStep>): Promise<TypingStep[]> {
  const out: TypingStep[] = []
  for await (const s of iter) out.push(s)
  return out
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
})

describe('Humanizer — delay methods', () => {
  it('preActionDelay sleeps the lower bound when random()=0', async () => {
    const clock = new FakeClock()
    clock.randomValue = 0
    const h = new Humanizer({
      config: makeConfig({ preActionDelayMs: [80, 220] }),
      clock
    })
    await h.preActionDelay()
    expect(clock.slept).toEqual([80])
  })

  it('preActionDelay sleeps the upper bound when random()=1', async () => {
    const clock = new FakeClock()
    clock.randomValue = 1
    const h = new Humanizer({
      config: makeConfig({ preActionDelayMs: [80, 220] }),
      clock
    })
    await h.preActionDelay()
    expect(clock.slept).toEqual([220])
  })

  it('postActionDelay and readDelay sample inside their configured ranges', async () => {
    const clock = new FakeClock()
    clock.randomValue = 0.5
    const h = new Humanizer({
      config: makeConfig({
        postActionDelayMs: [200, 500],
        readDelayMs: [400, 1500]
      }),
      clock
    })
    await h.postActionDelay()
    await h.readDelay()
    expect(clock.slept).toHaveLength(2)
    expect(clock.slept[0]).toBe(350)
    expect(clock.slept[1]).toBe(950)
  })

  it('enabled=false short-circuits all four delay methods (no sleep calls)', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ enabled: false, longPauseProbability: 1 }),
      clock
    })
    await h.preActionDelay()
    await h.postActionDelay()
    await h.readDelay()
    await h.maybeLongPause()
    expect(clock.slept).toEqual([])
  })

  it('maybeLongPause is a no-op when longPauseProbability=0', async () => {
    const clock = new FakeClock()
    clock.randomValue = 0
    const h = new Humanizer({
      config: makeConfig({ longPauseProbability: 0 }),
      clock
    })
    await h.maybeLongPause()
    expect(clock.slept).toEqual([])
  })

  it('maybeLongPause sleeps within longPauseMs when longPauseProbability=1', async () => {
    const clock = new FakeClock()
    // First draw rolls the probability gate, second draw samples the duration.
    clock.randomQueue = [0.3, 0]
    const h = new Humanizer({
      config: makeConfig({ longPauseProbability: 1, longPauseMs: [1500, 4000] }),
      clock
    })
    await h.maybeLongPause()
    expect(clock.slept).toEqual([1500])
  })
})

describe('Humanizer — jitterCoords', () => {
  it('returns input unchanged when clickJitterPx === 0', () => {
    const clock = new FakeClock()
    clock.randomValue = 0.5
    const h = new Humanizer({ config: makeConfig({ clickJitterPx: 0 }), clock })
    expect(h.jitterCoords(100, 200)).toEqual([100, 200])
  })

  it('returns input unchanged when enabled=false', () => {
    const clock = new FakeClock()
    clock.randomValue = 0.5
    const h = new Humanizer({
      config: makeConfig({ enabled: false, clickJitterPx: 5 }),
      clock
    })
    expect(h.jitterCoords(100, 200)).toEqual([100, 200])
  })

  it('produces deterministic offsets within ±clickJitterPx for 5 distinct randoms', () => {
    const clock = new FakeClock()
    const j = 3
    const h = new Humanizer({ config: makeConfig({ clickJitterPx: j }), clock })
    const observed: Array<[number, number]> = []
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      clock.randomValue = r
      const [x, y] = h.jitterCoords(0, 0)
      observed.push([x, y])
      expect(x).toBeGreaterThanOrEqual(-j)
      expect(x).toBeLessThanOrEqual(j)
      expect(y).toBeGreaterThanOrEqual(-j)
      expect(y).toBeLessThanOrEqual(j)
    }
    // Same random twice → identical output (determinism).
    clock.randomValue = 0.25
    expect(h.jitterCoords(0, 0)).toEqual(observed[1])
  })

  it('hits the lower and upper bounds at random=0 and random=1', () => {
    const clock = new FakeClock()
    const h = new Humanizer({ config: makeConfig({ clickJitterPx: 4 }), clock })
    clock.randomValue = 0
    expect(h.jitterCoords(10, 10)).toEqual([6, 6])
    clock.randomValue = 1
    expect(h.jitterCoords(10, 10)).toEqual([14, 14])
  })
})

describe('Humanizer — updateConfig', () => {
  it('shallow-merges patch and observes the new value on the next call', () => {
    const clock = new FakeClock()
    clock.randomValue = 0
    const h = new Humanizer({ config: makeConfig({ clickJitterPx: 5 }), clock })
    expect(h.jitterCoords(0, 0)).toEqual([-5, -5])
    h.updateConfig({ clickJitterPx: 0 })
    expect(h.jitterCoords(0, 0)).toEqual([0, 0])
  })

  it('updateConfig({}) is a no-op', async () => {
    const clock = new FakeClock()
    clock.randomValue = 0
    const h = new Humanizer({
      config: makeConfig({ preActionDelayMs: [100, 100] }),
      clock
    })
    h.updateConfig({})
    await h.preActionDelay()
    expect(clock.slept).toEqual([100])
  })
})

describe('Humanizer — typingPlan', () => {
  it("yields exactly 5 type steps with charIndex 0..4 for 'hello'", async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ typoProbability: 0, longPauseProbability: 0 }),
      clock
    })
    const steps = await collectSteps(h.typingPlan('hello'))
    expect(steps).toHaveLength(5)
    steps.forEach((s, i) => {
      expect(s.type).toBe('type')
      if (s.type === 'type') {
        expect(s.charIndex).toBe(i)
        expect(s.ms).toBeGreaterThan(0)
      }
    })
  })

  it("emits a punctuation pause after '。' in '你好。'", async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({
        typoProbability: 0,
        longPauseProbability: 0,
        punctuationPauseMs: [100, 300]
      }),
      clock
    })
    const steps = await collectSteps(h.typingPlan('你好。'))
    const punctPauses = steps.filter((s) => s.type === 'pause' && s.reason === 'punctuation')
    expect(punctPauses).toHaveLength(1)
    const last = steps[steps.length - 1]
    expect(last.type).toBe('pause')
    if (last.type === 'pause') {
      expect(last.reason).toBe('punctuation')
      expect(last.ms).toBeGreaterThanOrEqual(100)
      expect(last.ms).toBeLessThanOrEqual(300)
    }
  })

  it("emits a punctuation pause after '.' in 'hi.'", async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ typoProbability: 0, longPauseProbability: 0 }),
      clock
    })
    const steps = await collectSteps(h.typingPlan('hi.'))
    const punctPauses = steps.filter((s) => s.type === 'pause' && s.reason === 'punctuation')
    expect(punctPauses).toHaveLength(1)
  })

  it('emits a typo step for every character after the first when typoProbability=1', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ typoProbability: 1, longPauseProbability: 0 }),
      clock
    })
    const text = 'abcd'
    const steps = await collectSteps(h.typingPlan(text))
    // No long pauses → exactly one keystroke step per character.
    const keystrokes = steps.filter((s) => s.type === 'type' || s.type === 'typo')
    expect(keystrokes).toHaveLength(text.length)
    expect(keystrokes[0].type).toBe('type')
    for (let i = 1; i < keystrokes.length; i++) {
      const s = keystrokes[i]
      expect(s.type).toBe('typo')
      if (s.type === 'typo') {
        expect(s.charIndex).toBe(i)
        expect(s.wrongChar.length).toBe(1)
        expect(s.wrongChar).not.toBe(text[i])
      }
    }
  })

  it('inserts a pause(long) between consecutive chars when longPauseProbability=1', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({
        typoProbability: 0,
        longPauseProbability: 1,
        longPauseMs: [1500, 4000]
      }),
      clock
    })
    const steps = await collectSteps(h.typingPlan('abc'))
    const longPauses = steps.filter((s) => s.type === 'pause' && s.reason === 'long')
    expect(longPauses).toHaveLength(2)
    for (const p of longPauses) {
      if (p.type === 'pause') {
        expect(p.ms).toBeGreaterThanOrEqual(1500)
        expect(p.ms).toBeLessThanOrEqual(4000)
      }
    }
    // First emitted step must still be the keystroke for 'a' (no pause before
    // the first character).
    expect(steps[0].type).toBe('type')
  })

  it('enabled=false yields exactly N type steps with ms=0 (no typos, no pauses)', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({
        enabled: false,
        typoProbability: 1,
        longPauseProbability: 1
      }),
      clock
    })
    const steps = await collectSteps(h.typingPlan('abc'))
    expect(steps).toHaveLength(3)
    steps.forEach((s, i) => {
      expect(s.type).toBe('type')
      if (s.type === 'type') {
        expect(s.ms).toBe(0)
        expect(s.charIndex).toBe(i)
      }
    })
  })

  it('typingPlan(text) called twice yields two independent walks', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ typoProbability: 0, longPauseProbability: 0 }),
      clock
    })
    const first = await collectSteps(h.typingPlan('ab'))
    const second = await collectSteps(h.typingPlan('ab'))
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // Independence: indices restart from 0 each walk.
    expect(first.every((s, i) => s.type === 'type' && s.charIndex === i)).toBe(true)
    expect(second.every((s, i) => s.type === 'type' && s.charIndex === i)).toBe(true)
  })

  it('logs a debug record on typingPlan start with the text length', async () => {
    const clock = new FakeClock()
    const h = new Humanizer({
      config: makeConfig({ typoProbability: 0, longPauseProbability: 0 }),
      clock
    })
    await collectSteps(h.typingPlan('hello'))
    const start = logBuffer
      .getAll()
      .find((r) => r.level === 'debug' && r.msg === 'Typing plan start')
    expect(start).toBeDefined()
    expect(start?.phase).toBe('policy.humanizer')
    expect(start?.data?.length).toBe(5)
  })
})
