import { describe, expect, it } from 'vitest'
import { redact } from './redact'

describe('redact', () => {
  it('redacts apiKey and preserves other keys', () => {
    const input = { apiKey: 'sk-x', name: 'John' }
    const result = redact(input)
    expect(result).toEqual({ apiKey: '[REDACTED]', name: 'John' })
  })

  it('does not mutate the original input', () => {
    const input = { apiKey: 'secret', name: 'safe' }
    const copy = { ...input }
    redact(input)
    expect(input).toEqual(copy)
  })

  it('is case-insensitive: API_KEY is redacted', () => {
    expect(redact({ API_KEY: 'x' })).toEqual({ API_KEY: '[REDACTED]' })
  })

  it('is case-insensitive: Authorization is redacted', () => {
    expect(redact({ Authorization: 'Bearer tok' })).toEqual({ Authorization: '[REDACTED]' })
  })

  it('is case-insensitive: Bearer is redacted', () => {
    expect(redact({ Bearer: 'tok' })).toEqual({ Bearer: '[REDACTED]' })
  })

  it('is case-insensitive: password is redacted', () => {
    expect(redact({ password: 'hunter2' })).toEqual({ password: '[REDACTED]' })
  })

  it('is case-insensitive: secret and token are redacted', () => {
    expect(redact({ secret: 'x', token: 'y' })).toEqual({
      secret: '[REDACTED]',
      token: '[REDACTED]'
    })
  })

  it('redacts nested sensitive keys', () => {
    expect(redact({ a: { token: 'x', safe: 1 } })).toEqual({ a: { token: '[REDACTED]', safe: 1 } })
  })

  it('redacts sensitive keys in array elements', () => {
    const result = redact([{ secret: 'x' }, 'safe']) as unknown[]
    expect(result[0]).toEqual({ secret: '[REDACTED]' })
    expect(result[1]).toBe('safe')
  })

  it('is cycle-safe', () => {
    const o: Record<string, unknown> = { a: 1 }
    o['self'] = o
    expect(() => redact(o)).not.toThrow()
  })

  it('masks email values regardless of key', () => {
    const result = redact({ contact: 'contact@example.com' })
    expect(result).toEqual({ contact: 'c***@example.com' })
  })

  it('masks email in plain string value', () => {
    const result = redact('user@domain.org')
    expect(result).toBe('u***@domain.org')
  })

  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(true)).toBe(true)
  })

  it('does not redact partial key matches (e.g. mytoken)', () => {
    // SENSITIVE_KEY_RE is full-match, so 'mytoken' should NOT be redacted
    expect(redact({ mytoken: 'x' })).toEqual({ mytoken: 'x' })
  })
})
