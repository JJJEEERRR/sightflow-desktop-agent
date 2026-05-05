/**
 * Content-Security-Policy + ancillary security header construction for the
 * renderer. Extracted from `src/main/index.ts` so the CSP string itself can be
 * unit-tested without booting Electron, and so future tweaks to the policy
 * don't drag the window-creation code along with them.
 *
 * Threat model recap (full version in ADR-0009):
 *   - The renderer renders untrusted-ish content (LLM output, screenshots,
 *     locale strings) and must never become an XSS → main-process pivot.
 *   - All outbound network calls go through the main process via IPC; the
 *     renderer's only legitimate `connect-src` is `'self'` (loopback HTTP from
 *     Vite in dev, file:// in prod).
 *   - Inline scripts are forbidden in production. In dev, electron-vite's HMR
 *     client injects inline `<script>` tags, so we relax `script-src` only
 *     when `is.dev` is true.
 *
 * The directives are intentionally sorted by name in `buildCsp` so unit tests
 * can assert on stable substrings.
 */

export interface CspOptions {
  /** True when running under electron-vite's dev server (HMR active). */
  isDev: boolean
}

/**
 * The Content-Security-Policy directives we apply, keyed by directive name
 * and ordered for human readability when the policy is logged. Each value is
 * the directive's source list (already space-separated).
 *
 * Why this shape (record of arrays) instead of a hand-built string:
 *   - Unit tests can introspect individual directives without re-parsing.
 *   - Adding a new source (e.g. an allow-listed AI endpoint, when/if the
 *     renderer ever calls one directly) is a one-line array push, not a
 *     fragile string-concatenation patch.
 */
export function cspDirectives(opts: CspOptions): Record<string, readonly string[]> {
  const scriptSrc: string[] = ["'self'"]
  if (opts.isDev) {
    // Vite HMR client emits inline `<script>` blocks and uses `eval` for
    // module evaluation in dev. We accept the relaxation because the dev
    // build is never shipped and the loaded URL is loopback-only.
    scriptSrc.push("'unsafe-inline'", "'unsafe-eval'")
  }

  return {
    'default-src': ["'self'"],
    'script-src': scriptSrc,
    // React (and many CSS-in-JS solutions) inject inline `style=""` attributes
    // and `<style>` tags. The threat from inline styles is bounded (no script
    // execution); we accept it for the sake of keeping the renderer simple.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    // Renderer makes no outbound HTTP calls today — all LLM traffic happens
    // in main via OpenAICompatProvider over IPC. `'self'` covers the dev
    // server's HMR websocket and prod's file:// origin.
    'connect-src': ["'self'"],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"]
  }
}

/**
 * Serialise the directive map to a single header value. Directives are joined
 * with `; ` and trailing semicolons are intentionally omitted (RFC permits
 * either; omitting is marginally easier to read in DevTools).
 */
export function buildCsp(opts: CspOptions): string {
  const directives = cspDirectives(opts)
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}

/**
 * Headers we set on every renderer response. Includes the CSP plus a small
 * set of belt-and-suspenders defenses that cost nothing.
 *
 * - `X-Content-Type-Options: nosniff` — disable MIME sniffing on any blob:/
 *   data: resource the renderer might load.
 * - `X-Frame-Options: DENY` — defense-in-depth alongside `frame-src 'none'`
 *   in the CSP above.
 * - `Referrer-Policy: no-referrer` — the renderer has no business leaking
 *   page URLs to third parties; there are no third parties.
 */
export function securityHeaders(opts: CspOptions): Record<string, string[]> {
  return {
    'Content-Security-Policy': [buildCsp(opts)],
    'X-Content-Type-Options': ['nosniff'],
    'X-Frame-Options': ['DENY'],
    'Referrer-Policy': ['no-referrer']
  }
}
