import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Schedule } from './schedule'
import { defaultAntiDetectionConfig, type ScheduleConfig } from './config'
import { configureLogger, resetLoggerForTests } from '../observability'
import { RingBufferSink } from '../observability/sinks/ring-buffer-sink'

/**
 * Reference dates used throughout the suite (local time):
 *   2026-05-04  Monday    (getDay() === 1)
 *   2026-05-05  Tuesday   (getDay() === 2)
 *   2026-05-08  Friday    (getDay() === 5)
 *
 * Cross-midnight convention exercised below: a window `["22:00", "02:00"]` on
 * weekday key '1' (Monday) makes Monday awake from 22:00 through 23:59 AND
 * from 00:00 through 02:00 of the SAME calendar day. Tuesday is unaffected.
 */
function fixedDate(iso: string): () => Date {
  const d = new Date(iso)
  return () => d
}

function baseConfig(over: Partial<ScheduleConfig> = {}): ScheduleConfig {
  const def = defaultAntiDetectionConfig().schedule
  return { ...def, ...over }
}

let logBuffer: RingBufferSink

beforeEach(() => {
  logBuffer = new RingBufferSink({ size: 200 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'debug' })
})

afterEach(() => {
  resetLoggerForTests()
})

describe('Schedule.isAwake', () => {
  it('returns awake:true when scheduling is disabled', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: false }),
      now: fixedDate('2026-05-04T03:00:00')
    })
    expect(sched.isAwake()).toEqual({ awake: true })
  })

  it('is never awake (and nextAwakeAt is null) when enabled with no windows', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: true, windows: {} }),
      now: fixedDate('2026-05-04T10:00:00')
    })
    expect(sched.isAwake()).toEqual({
      awake: false,
      nextAwakeAt: null,
      reason: 'outOfWindow'
    })
  })

  it('is awake when the current time falls inside a single window', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: true, windows: { '1': [['09:00', '17:00']] } }),
      now: fixedDate('2026-05-04T10:00:00')
    })
    expect(sched.isAwake()).toEqual({ awake: true })
  })

  it('points nextAwakeAt at today’s upcoming window when one is still ahead', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: true, windows: { '1': [['09:00', '17:00']] } }),
      now: fixedDate('2026-05-04T08:00:00')
    })
    const r = sched.isAwake()
    expect(r.awake).toBe(false)
    if (!r.awake) {
      expect(r.reason).toBe('outOfWindow')
      expect(r.nextAwakeAt).toEqual(new Date('2026-05-04T09:00:00'))
    }
  })

  it('walks to the next day when today’s windows have all passed', () => {
    const sched = new Schedule({
      config: baseConfig({
        enabled: true,
        windows: {
          '1': [['09:00', '17:00']],
          '2': [['10:00', '12:00']]
        }
      }),
      now: fixedDate('2026-05-04T18:00:00')
    })
    const r = sched.isAwake()
    expect(r.awake).toBe(false)
    if (!r.awake) {
      expect(r.nextAwakeAt).toEqual(new Date('2026-05-05T10:00:00'))
    }
  })

  it('treats both window endpoints as inclusive', () => {
    const cfg = baseConfig({ enabled: true, windows: { '1': [['09:00', '17:00']] } })

    const atStart = new Schedule({ config: cfg, now: fixedDate('2026-05-04T09:00:00') })
    expect(atStart.isAwake().awake).toBe(true)

    const atEnd = new Schedule({ config: cfg, now: fixedDate('2026-05-04T17:00:00') })
    expect(atEnd.isAwake().awake).toBe(true)

    const justAfter = new Schedule({ config: cfg, now: fixedDate('2026-05-04T17:01:00') })
    expect(justAfter.isAwake().awake).toBe(false)
  })

  it('handles multiple windows in one day (awake during the second one)', () => {
    const sched = new Schedule({
      config: baseConfig({
        enabled: true,
        windows: {
          '1': [
            ['09:00', '12:00'],
            ['14:00', '17:00']
          ]
        }
      }),
      now: fixedDate('2026-05-04T15:00:00')
    })
    expect(sched.isAwake().awake).toBe(true)
  })

  it('between two same-day windows: awake:false, nextAwakeAt is the second start', () => {
    const sched = new Schedule({
      config: baseConfig({
        enabled: true,
        windows: {
          '1': [
            ['09:00', '12:00'],
            ['14:00', '17:00']
          ]
        }
      }),
      now: fixedDate('2026-05-04T13:00:00')
    })
    const r = sched.isAwake()
    expect(r.awake).toBe(false)
    if (!r.awake) {
      expect(r.nextAwakeAt).toEqual(new Date('2026-05-04T14:00:00'))
    }
  })

  it('cross-midnight: window [22:00,02:00] is awake at 23:30, 01:30 and asleep at 03:00 on the SAME weekday key', () => {
    const cfg = baseConfig({ enabled: true, windows: { '1': [['22:00', '02:00']] } })

    const late = new Schedule({ config: cfg, now: fixedDate('2026-05-04T23:30:00') })
    expect(late.isAwake().awake).toBe(true)

    const earlyAm = new Schedule({ config: cfg, now: fixedDate('2026-05-04T01:30:00') })
    expect(earlyAm.isAwake().awake).toBe(true)

    const past = new Schedule({ config: cfg, now: fixedDate('2026-05-04T03:00:00') })
    const pastResult = past.isAwake()
    expect(pastResult.awake).toBe(false)
    if (!pastResult.awake) {
      expect(pastResult.nextAwakeAt).toEqual(new Date('2026-05-04T22:00:00'))
    }
  })

  it('returns nextAwakeAt:null when enabled but no windows exist anywhere in the 7-day horizon', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: true, windows: {} }),
      now: fixedDate('2026-05-04T12:00:00')
    })
    const r = sched.isAwake()
    expect(r.awake).toBe(false)
    if (!r.awake) {
      expect(r.nextAwakeAt).toBeNull()
    }
  })

  it('updateConfig is reflected in the next isAwake call', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: false }),
      now: fixedDate('2026-05-04T03:00:00')
    })
    expect(sched.isAwake().awake).toBe(true)

    sched.updateConfig({ enabled: true, windows: { '1': [['09:00', '17:00']] } })

    const r = sched.isAwake()
    expect(r.awake).toBe(false)
    if (!r.awake) {
      expect(r.nextAwakeAt).toEqual(new Date('2026-05-04T09:00:00'))
    }
  })

  it('logs exactly one info record when isAwake transitions across a window boundary', () => {
    const cfg = baseConfig({ enabled: true, windows: { '1': [['09:00', '17:00']] } })

    // First call at 16:59 → awake. No transition log on the very first call.
    const earlier = new Schedule({ config: cfg, now: fixedDate('2026-05-04T16:59:00') })
    earlier.isAwake()
    earlier.isAwake() // still awake — no log
    expect(
      logBuffer.getAll().filter((r) => r.level === 'info' && r.phase === 'policy.schedule').length
    ).toBe(0)

    // New instance, but we want a single instance crossing the boundary, so
    // build a Schedule whose `now` we can advance via a closure.
    let current = new Date('2026-05-04T16:59:00')
    const sched = new Schedule({
      config: cfg,
      now: () => current
    })

    sched.isAwake() // awake (initial — no log)
    sched.isAwake() // awake (no log)
    current = new Date('2026-05-04T17:01:00')
    sched.isAwake() // not awake — transition log #1
    sched.isAwake() // not awake (no log)

    const transitionLogs = logBuffer
      .getAll()
      .filter((r) => r.level === 'info' && r.phase === 'policy.schedule')
    expect(transitionLogs.length).toBe(1)
    expect(transitionLogs[0].msg).toBe('awake-state-changed')
    expect(transitionLogs[0].data).toMatchObject({ from: true, to: false })
  })
})

describe('Schedule.maybeAfk', () => {
  it('returns afk:false when probability is 0', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: true, afkProbability: 0 }),
      now: fixedDate('2026-05-04T10:00:00'),
      random: () => 0.5
    })
    for (let i = 0; i < 10; i++) {
      expect(sched.maybeAfk()).toEqual({ afk: false })
    }
  })

  it('returns afk:true with durationMs inside afkDurationMs when probability is 1', () => {
    const sched = new Schedule({
      config: baseConfig({
        enabled: true,
        afkProbability: 1,
        afkDurationMs: [30_000, 180_000]
      }),
      now: fixedDate('2026-05-04T10:00:00'),
      random: () => 0.5
    })
    for (let i = 0; i < 10; i++) {
      const r = sched.maybeAfk()
      expect(r.afk).toBe(true)
      if (r.afk) {
        expect(r.durationMs).toBeGreaterThanOrEqual(30_000)
        expect(r.durationMs).toBeLessThanOrEqual(180_000)
      }
    }
  })

  it('honours the [min, max] bounds at the random extremes', () => {
    const cfg = baseConfig({
      enabled: true,
      afkProbability: 1,
      afkDurationMs: [1_000, 5_000]
    })

    const lo = new Schedule({ config: cfg, now: fixedDate('2026-05-04T10:00:00'), random: () => 0 })
    const r1 = lo.maybeAfk()
    expect(r1.afk).toBe(true)
    if (r1.afk) {
      expect(r1.durationMs).toBe(1_000)
    }

    // 0.999... pushes the floored draw to the top of the range; we clamp to max.
    const hi = new Schedule({
      config: cfg,
      now: fixedDate('2026-05-04T10:00:00'),
      random: () => 0.9999999
    })
    const r2 = hi.maybeAfk()
    expect(r2.afk).toBe(true)
    if (r2.afk) {
      expect(r2.durationMs).toBeLessThanOrEqual(5_000)
      expect(r2.durationMs).toBeGreaterThanOrEqual(1_000)
    }
  })

  it('returns afk:false regardless of probability when scheduling is disabled', () => {
    const sched = new Schedule({
      config: baseConfig({ enabled: false, afkProbability: 1 }),
      now: fixedDate('2026-05-04T10:00:00'),
      random: () => 0
    })
    for (let i = 0; i < 5; i++) {
      expect(sched.maybeAfk()).toEqual({ afk: false })
    }
  })
})
