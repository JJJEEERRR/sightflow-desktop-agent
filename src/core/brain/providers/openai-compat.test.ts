import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { OpenAICompatProvider } from './openai-compat'
import { configureLogger, resetLoggerForTests, RingBufferSink } from '../../observability'

type FetchSpy = MockInstance<
  Parameters<typeof globalThis.fetch>,
  ReturnType<typeof globalThis.fetch>
>

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function chatCompletion(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

let fetchSpy: FetchSpy

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
  // Provider delegates to AIClient which writes to the structured logger.
  // We don't assert on records here, but we install a buffer so
  // log writes don't leak into the console during the test run.
  configureLogger({ env: 'dev', sinks: [new RingBufferSink({ size: 50 })], minLevel: 'trace' })
})

afterEach(() => {
  vi.restoreAllMocks()
  resetLoggerForTests()
})

describe('OpenAICompatProvider.callVision', () => {
  it('forwards system prompt, user text, and image into a chat-completions payload', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('hi')))
    const provider = new OpenAICompatProvider({ apiKey: 'k' })

    const out = await provider.callVision('SYS', 'USER', 'data:image/png;base64,AAA')

    expect(out).toBe('hi')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0]!
    const body = JSON.parse(init?.body as string)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.messages[1].role).toBe('user')
    // user content is a [{image_url}, {text}] tuple per OpenAI multimodal shape
    expect(Array.isArray(body.messages[1].content)).toBe(true)
    const imageEntry = body.messages[1].content.find(
      (e: { type: string }) => e.type === 'image_url'
    )
    const textEntry = body.messages[1].content.find((e: { type: string }) => e.type === 'text')
    expect(imageEntry.image_url.url).toContain('base64,AAA')
    expect(textEntry.text).toBe('USER')
  })

  it('strips a duplicate `data:image/png;base64,` prefix before sending', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('ok')))
    const provider = new OpenAICompatProvider({ apiKey: 'k' })

    await provider.callVision('s', 'u', 'data:image/png;base64,XYZ')

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
    const url = body.messages[1].content.find((e: { type: string }) => e.type === 'image_url')
      .image_url.url
    // Must not be doubly-prefixed
    const matches = url.match(/data:image\/png;base64,/g) ?? []
    expect(matches.length).toBe(1)
    expect(url.endsWith(',XYZ')).toBe(true)
  })
})

describe('OpenAICompatProvider.callText', () => {
  it('sends a single user message and returns the assistant content', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('hello back')))
    const provider = new OpenAICompatProvider({ apiKey: 'k' })

    const out = await provider.callText('hi')

    expect(out).toBe('hello back')
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('OpenAICompatProvider.testConnection', () => {
  it('returns {success:true} when the underlying call resolves', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('连接成功')))
    const provider = new OpenAICompatProvider({ apiKey: 'k' })

    const result = await provider.testConnection()

    expect(result).toEqual({ success: true })
  })

  it('returns {success:false, error:…} on a non-2xx status (no throw)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { error: 'unauth' }))
    const provider = new OpenAICompatProvider({ apiKey: 'bad' })

    const result = await provider.testConnection()

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/401/)
  })
})

describe('OpenAICompatProvider.updateConfig', () => {
  it('forwards partial config to the underlying client (model swap takes effect on next call)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, chatCompletion('ok')))
    const provider = new OpenAICompatProvider({
      apiKey: 'k',
      model: 'old-model',
      baseURL: 'https://a.example.com/api/v3'
    })

    provider.updateConfig({ model: 'new-model', baseURL: 'https://b.example.com/api/v3' })
    await provider.callText('probe')

    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('https://b.example.com/api/v3/chat/completions')
    const body = JSON.parse(init?.body as string)
    expect(body.model).toBe('new-model')
  })
})
