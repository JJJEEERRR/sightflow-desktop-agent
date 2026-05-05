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
