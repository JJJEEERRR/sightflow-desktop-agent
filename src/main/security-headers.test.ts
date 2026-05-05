import { describe, expect, it } from 'vitest'
import { buildCsp, cspDirectives, securityHeaders } from './security-headers'

describe('cspDirectives', () => {
  it('emits the production directive set without unsafe-* in script-src', () => {
    const d = cspDirectives({ isDev: false })

    expect(d['default-src']).toEqual(["'self'"])
    expect(d['script-src']).toEqual(["'self'"])
    expect(d['script-src']).not.toContain("'unsafe-inline'")
    expect(d['script-src']).not.toContain("'unsafe-eval'")
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"])
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(d['connect-src']).toEqual(["'self'"])
    expect(d['font-src']).toEqual(["'self'", 'data:'])
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['frame-src']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'none'"])
  })

  it('relaxes script-src in dev mode for HMR (unsafe-inline + unsafe-eval)', () => {
    const d = cspDirectives({ isDev: true })

    expect(d['script-src']).toContain("'self'")
    expect(d['script-src']).toContain("'unsafe-inline'")
    expect(d['script-src']).toContain("'unsafe-eval'")
  })

  it('does not leak unsafe-* into non-script directives even in dev', () => {
    const d = cspDirectives({ isDev: true })

    expect(d['default-src']).not.toContain("'unsafe-inline'")
    expect(d['default-src']).not.toContain("'unsafe-eval'")
    expect(d['connect-src']).not.toContain("'unsafe-inline'")
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['frame-src']).toEqual(["'none'"])
    expect(d['form-action']).toEqual(["'none'"])
  })
})

describe('buildCsp', () => {
  it('serialises to a semicolon-separated header in prod', () => {
    const csp = buildCsp({ isDev: false })

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'none'")
    // Directives are joined by `; `; no trailing semicolon.
    expect(csp.endsWith(';')).toBe(false)
    expect(csp.split('; ').length).toBeGreaterThan(5)
  })

  it('includes unsafe-eval in dev script-src and not in prod', () => {
    const dev = buildCsp({ isDev: true })
    const prod = buildCsp({ isDev: false })

    expect(dev).toMatch(/script-src [^;]*'unsafe-eval'/)
    expect(prod).not.toMatch(/'unsafe-eval'/)
    expect(dev).toMatch(/script-src [^;]*'unsafe-inline'/)
    expect(prod).not.toMatch(/script-src [^;]*'unsafe-inline'/)
  })
})

describe('securityHeaders', () => {
  it('returns CSP plus the defense-in-depth headers', () => {
    const h = securityHeaders({ isDev: false })

    expect(h['Content-Security-Policy']).toHaveLength(1)
    expect(h['Content-Security-Policy'][0]).toContain("default-src 'self'")
    expect(h['X-Content-Type-Options']).toEqual(['nosniff'])
    expect(h['X-Frame-Options']).toEqual(['DENY'])
    expect(h['Referrer-Policy']).toEqual(['no-referrer'])
  })

  it('every header value is an array (Electron onHeadersReceived contract)', () => {
    const h = securityHeaders({ isDev: true })
    for (const [, value] of Object.entries(h)) {
      expect(Array.isArray(value)).toBe(true)
      expect(value.length).toBeGreaterThan(0)
    }
  })
})
