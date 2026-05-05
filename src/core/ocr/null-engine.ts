import type { OcrEngine } from './types'

/**
 * NullOcrEngine — used in tests and as the production default whenever
 * `policy.ocr.enabled === false`. Pays zero runtime cost; never returns
 * any text so the breaker never sees a `screenText` signal from it.
 */
export class NullOcrEngine implements OcrEngine {
  async extract(): Promise<string> {
    return ''
  }

  async dispose(): Promise<void> {
    // intentional no-op
  }
}
