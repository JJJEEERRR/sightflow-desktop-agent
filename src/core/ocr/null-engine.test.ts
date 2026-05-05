import { describe, expect, it } from 'vitest'
import { NullOcrEngine } from './null-engine'

describe('NullOcrEngine', () => {
  it('extract returns the empty string', async () => {
    const engine = new NullOcrEngine()
    expect(await engine.extract()).toBe('')
  })

  it('dispose resolves without error and is idempotent', async () => {
    const engine = new NullOcrEngine()
    await expect(engine.dispose()).resolves.toBeUndefined()
    await expect(engine.dispose()).resolves.toBeUndefined()
  })
})
