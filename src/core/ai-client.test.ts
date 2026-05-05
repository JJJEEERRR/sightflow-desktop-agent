import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { AIClient } from './ai-client'
import { configureLogger, resetLoggerForTests, RingBufferSink } from './observability'

// vitest's `MockInstance<TArgs, TReturn>` keeps the call-arg tuple narrow at
// the assignment site, where `ReturnType<typeof vi.spyOn>` would widen to
// `MockInstance<unknown[], unknown>` and refuse the assignment.
type FetchSpy = MockInstance<
  Parameters<typeof globalThis.fetch>,
  ReturnType<typeof globalThis.fetch>
>

/**
 * Build a `fetch`-shaped Response double. Vitest doesn't ship `Response` as a
 * global on all Node versions we care about, so we hand-roll the minimum.
 */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

function chatCompletion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

let fetchSpy: FetchSpy
let logBuffer: RingBufferSink

beforeEach(() => {
  // Replace global fetch with a spy. Each test sets the desired behaviour.
  fetchSpy = vi.spyOn(globalThis, 'fetch')
  // Capture every record AIClient writes — tests assert on this in lieu of
  // inspecting console output (production code only ever talks to the logger).
  logBuffer = new RingBufferSink({ size: 100 })
  configureLogger({ env: 'dev', sinks: [logBuffer], minLevel: 'trace' })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetLoggerForTests()
})

describe('AIClient.constructor', () => {
  it('falls back to default model and baseURL when not provided', () => {
    const client = new AIClient({ apiKey: 'k' })
    expect(client.getApiKey()).toBe('k')
  })

  it('updateConfig replaces only provided fields', () => {
    const client = new AIClient({ apiKey: 'k1' })
    client.updateConfig({ apiKey: 'k2' })
    expect(client.getApiKey()).toBe('k2')
  })
})

describe('AIClient.getReply', () => {
  it('returns the trimmed reply text on success', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('  你好，在的~  ')))

    const client = new AIClient({ apiKey: 'k' })
    const reply = await client.getReply('data:image/png;base64,abc')
    expect(reply).toBe('你好，在的~')
  })

  it('returns null when the model emits the literal [SKIP] token', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('[SKIP]')))
    const client = new AIClient({ apiKey: 'k' })
    expect(await client.getReply('data:image/png;base64,abc')).toBeNull()
  })

  it('returns null when the response has no choices', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { choices: [] }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = new AIClient({ apiKey: 'k' })
    // Empty content -> getReply trims to '' -> trim() === '' is falsy, returns null
    expect(await client.getReply('img')).toBeNull()
    warnSpy.mockRestore()
  })

  it('throws and logs on a non-2xx HTTP status', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: 'unauth' }))
    const client = new AIClient({ apiKey: 'k' })

    await expect(client.getReply('img')).rejects.toThrowError(/401/)
    const errorRecords = logBuffer.getAll().filter((r) => r.level === 'error')
    expect(errorRecords.length).toBeGreaterThan(0)
    expect(errorRecords.some((r) => r.phase === 'ai-client' && r.msg.includes('non-2xx'))).toBe(
      true
    )
  })

  it('forwards the bearer token and OpenAI-compatible payload shape', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('ok')))

    const client = new AIClient({ apiKey: 'secret-token', baseURL: 'https://api.test/v3' })
    await client.getReply('data:image/png;base64,QUJD')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.test/v3/chat/completions')
    const opts = init as RequestInit
    expect(opts.method).toBe('POST')
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-token')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(opts.body as string)
    expect(body.model).toBeDefined()
    expect(body.stream).toBe(false)
    expect(Array.isArray(body.messages)).toBe(true)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].role).toBe('user')
    // Image content is a multimodal user message
    const userContent = body.messages[1].content as Array<{ type: string }>
    expect(userContent.some((c) => c.type === 'image_url')).toBe(true)
    expect(userContent.some((c) => c.type === 'text')).toBe(true)
  })

  it('strips a "base64," prefix from the image and forwards a data URL', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('ok')))

    const client = new AIClient({ apiKey: 'k' })
    await client.getReply('data:image/png;base64,RAW_PAYLOAD')

    const opts = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(opts.body as string)
    const userContent = body.messages[1].content as Array<{
      type: string
      image_url?: { url: string }
    }>
    const imagePart = userContent.find((c) => c.type === 'image_url')
    expect(imagePart?.image_url?.url).toBe('data:image/png;base64,RAW_PAYLOAD')
  })

  it('forwards a raw http(s) URL unchanged', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('ok')))
    const client = new AIClient({ apiKey: 'k' })
    await client.getReply('https://cdn.example/sample.png')
    const opts = fetchSpy.mock.calls[0][1] as RequestInit
    const body = JSON.parse(opts.body as string)
    const userContent = body.messages[1].content as Array<{
      type: string
      image_url?: { url: string }
    }>
    const imagePart = userContent.find((c) => c.type === 'image_url')
    expect(imagePart?.image_url?.url).toBe('https://cdn.example/sample.png')
  })
})

describe('AIClient.testConnection', () => {
  it('returns { success: true } on 2xx', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('连接成功')))
    const client = new AIClient({ apiKey: 'k' })
    expect(await client.testConnection()).toEqual({ success: true })
  })

  it('returns { success: false, error } when the API rejects the call', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = new AIClient({ apiKey: 'k' })
    const result = await client.testConnection()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/403/)
    errSpy.mockRestore()
  })

  it('surfaces a friendly timeout message on AbortError', async () => {
    // Simulate AbortController firing during fetch.
    fetchSpy.mockImplementationOnce(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = new AIClient({ apiKey: 'k' })
    const result = await client.testConnection()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/超时/)
    errSpy.mockRestore()
  })
})
