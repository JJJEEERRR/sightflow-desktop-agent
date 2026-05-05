import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TesseractOcrEngine, type TesseractWorker } from './tesseract-engine'
import { configureLogger, resetLoggerForTests } from '../observability'

interface FakeWorkerOpts {
  recognize?: (buffer: Buffer) => Promise<{ data: { text: string } }> | { data: { text: string } }
  terminate?: () => Promise<void> | void
}

function makeFakeWorker(opts: FakeWorkerOpts = {}): TesseractWorker & {
  calls: { recognize: Buffer[]; terminate: number }
} {
  const calls = { recognize: [] as Buffer[], terminate: 0 }
  return {
    calls,
    recognize: async (buffer: Buffer) => {
      calls.recognize.push(buffer)
      const r = opts.recognize ? await opts.recognize(buffer) : { data: { text: '' } }
      return r
    },
    terminate: async () => {
      calls.terminate++
      await opts.terminate?.()
    }
  }
}

beforeEach(() => {
  // Silence logger output during these tests; the warn-on-failure path is
  // exercised behaviorally rather than by asserting on log output.
  configureLogger({ env: 'prod', sinks: [], minLevel: 'error' })
})

afterEach(() => {
  resetLoggerForTests()
  vi.restoreAllMocks()
})

describe('TesseractOcrEngine', () => {
  it('extract calls worker.recognize with the buffer and returns data.text', async () => {
    const worker = makeFakeWorker({
      recognize: async () => ({ data: { text: 'hello world' } })
    })
    const engine = new TesseractOcrEngine({ workerFactory: async () => worker })

    const buf = Buffer.from('PNG-DATA')
    const text = await engine.extract(buf)

    expect(text).toBe('hello world')
    expect(worker.calls.recognize).toHaveLength(1)
    expect(worker.calls.recognize[0].equals(buf)).toBe(true)
  })

  it('reuses the same worker across multiple extracts (lazy init only happens once)', async () => {
    const worker = makeFakeWorker({
      recognize: async () => ({ data: { text: 'x' } })
    })
    const factory = vi.fn(async () => worker)
    const engine = new TesseractOcrEngine({ workerFactory: factory })

    await engine.extract(Buffer.from('a'))
    await engine.extract(Buffer.from('b'))
    await engine.extract(Buffer.from('c'))

    expect(factory).toHaveBeenCalledTimes(1)
    expect(worker.calls.recognize).toHaveLength(3)
  })

  it('dispose calls worker.terminate; further extracts return ""', async () => {
    const worker = makeFakeWorker({
      recognize: async () => ({ data: { text: 'live' } })
    })
    const factory = vi.fn(async () => worker)
    const engine = new TesseractOcrEngine({ workerFactory: factory })

    expect(await engine.extract(Buffer.from('a'))).toBe('live')
    await engine.dispose()
    expect(worker.calls.terminate).toBe(1)

    // After dispose, the engine is dead — no further worker construction
    // and no recognize call.
    const text = await engine.extract(Buffer.from('b'))
    expect(text).toBe('')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(worker.calls.recognize).toHaveLength(1)
  })

  it('extract returns "" when worker.recognize throws', async () => {
    const worker = makeFakeWorker({
      recognize: async () => {
        throw new Error('tesseract crashed')
      }
    })
    const engine = new TesseractOcrEngine({ workerFactory: async () => worker })

    const text = await engine.extract(Buffer.from('a'))
    expect(text).toBe('')
  })

  it('extract returns "" and recovers on a transient workerFactory failure', async () => {
    let attempt = 0
    const goodWorker = makeFakeWorker({
      recognize: async () => ({ data: { text: 'recovered' } })
    })
    const factory = vi.fn(async (): Promise<TesseractWorker> => {
      attempt++
      if (attempt === 1) throw new Error('lang download timed out')
      return goodWorker
    })
    const engine = new TesseractOcrEngine({ workerFactory: factory })

    // First call: factory throws → engine catches and returns ''.
    expect(await engine.extract(Buffer.from('a'))).toBe('')
    // Second call: factory succeeds → engine recognizes normally.
    expect(await engine.extract(Buffer.from('b'))).toBe('recovered')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('dispose is idempotent (calling it twice does not throw)', async () => {
    const worker = makeFakeWorker()
    const engine = new TesseractOcrEngine({ workerFactory: async () => worker })
    await engine.extract(Buffer.from('a'))

    await expect(engine.dispose()).resolves.toBeUndefined()
    await expect(engine.dispose()).resolves.toBeUndefined()
    // terminate ran exactly once (subsequent dispose is a no-op).
    expect(worker.calls.terminate).toBe(1)
  })

  it('dispose without any prior extract is a no-op', async () => {
    const factory = vi.fn(async () => makeFakeWorker())
    const engine = new TesseractOcrEngine({ workerFactory: factory })

    await expect(engine.dispose()).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
  })
})
