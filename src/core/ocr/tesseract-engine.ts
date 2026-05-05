import { getLogger } from '../observability'
import type { OcrEngine } from './types'

/**
 * Minimal duck-typed view of a tesseract.js worker that we actually use.
 * Keeping our own interface (instead of importing the upstream type)
 * decouples our test fakes from the upstream type surface and lets the
 * production worker import stay dynamic. See ADR-0010.
 */
export interface TesseractWorker {
  recognize(buffer: Buffer): Promise<{ data: { text: string } }>
  terminate(): Promise<void>
}

export interface TesseractEngineOptions {
  /** Tesseract language pack(s). Combine with '+' (e.g. 'chi_sim+eng'). */
  language?: string
  /**
   * Optional override for tests: a function returning a tesseract worker.
   * Production uses the real tesseract.js worker (lazily imported on first
   * `extract()`). Replace with a fake to avoid touching the network.
   */
  workerFactory?: () => Promise<TesseractWorker>
}

const log = getLogger('ocr.tesseract')

/**
 * Production OCR backed by tesseract.js. The module import and language
 * data download are deferred to the first `extract()` call — loading the
 * package immediately at construction time would force the ~10MB
 * language-data fetch even when OCR is disabled.
 *
 * After `dispose()`, this engine returns '' from any further `extract()`
 * call. Callers that need a fresh engine after dispose should construct
 * a new instance — this matches the lifecycle model of the engine
 * (stop → restart rebuilds policy + OCR).
 */
export class TesseractOcrEngine implements OcrEngine {
  private readonly language: string
  private readonly workerFactory: () => Promise<TesseractWorker>
  private workerPromise: Promise<TesseractWorker> | null = null
  private disposed = false
  private warnedThisCycle = false

  constructor(opts: TesseractEngineOptions = {}) {
    this.language = opts.language ?? 'chi_sim+eng'
    this.workerFactory = opts.workerFactory ?? this.defaultWorkerFactory.bind(this)
  }

  async extract(screenshot: Buffer): Promise<string> {
    if (this.disposed) return ''
    try {
      const worker = await this.getWorker()
      const result = await worker.recognize(screenshot)
      // Reset the warn-once gate on a successful scan so a future failure
      // is announced again. Otherwise long-lived runs would only ever log
      // the very first failure.
      this.warnedThisCycle = false
      return result.data.text ?? ''
    } catch (err) {
      if (!this.warnedThisCycle) {
        this.warnedThisCycle = true
        log.warn('OCR extract failed; returning empty text', { err })
      }
      // A failed init poisons the cached worker promise; drop it so the
      // next call retries from scratch (otherwise a transient
      // language-data download error would stick forever).
      this.workerPromise = null
      return ''
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pending = this.workerPromise
    this.workerPromise = null
    if (!pending) return
    try {
      const worker = await pending
      await worker.terminate()
    } catch (err) {
      log.warn('OCR worker terminate failed', { err })
    }
  }

  private getWorker(): Promise<TesseractWorker> {
    if (!this.workerPromise) {
      this.workerPromise = this.workerFactory()
    }
    return this.workerPromise
  }

  /**
   * Default factory: dynamically import tesseract.js and create a worker.
   * Dynamic import means the ~10MB language data download is deferred
   * until OCR actually runs.
   */
  private async defaultWorkerFactory(): Promise<TesseractWorker> {
    const tesseract = (await import('tesseract.js')) as unknown as {
      createWorker: (lang: string) => Promise<TesseractWorker>
    }
    return tesseract.createWorker(this.language)
  }
}
