const SENSITIVE_KEY_RE = /^(api[_-]?key|token|secret|password|authorization|bearer)$/i
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

function maskEmail(value: string): string {
  return value.replace(EMAIL_RE, (match) => {
    const atIdx = match.indexOf('@')
    return match[0] + '***' + match.slice(atIdx)
  })
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return maskEmail(value)
    }
    return value
  }

  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen))
  }

  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const raw = (value as Record<string, unknown>)[key]
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactValue(raw, seen)
    }
  }
  return result
}

export function redact(input: unknown): unknown {
  return redactValue(input, new WeakSet())
}
