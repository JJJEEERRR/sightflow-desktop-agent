/**
 * OcrEngine — pluggable OCR boundary used by the engine to feed
 * `screenText` signals into the anti-detection circuit breaker.
 *
 * Implementations must be best-effort: any failure (initialization,
 * language-data download, recognition crash, …) MUST be swallowed and
 * surface as an empty string, so a flaky OCR layer never takes the
 * engine loop down. See ADR-0010 for the full rationale.
 */
export interface OcrEngine {
  /**
   * Extract text from a screenshot. Should NEVER throw — return '' on
   * failure and log a warn. Implementations are expected to be
   * best-effort: any error (including initialization, language-data
   * download, or tesseract crash) results in an empty string and a
   * single warn log per failure.
   */
  extract(screenshot: Buffer): Promise<string>

  /**
   * Releases internal resources (tesseract worker, etc.). Idempotent.
   * Called by the engine on stop / crash.
   */
  dispose(): Promise<void>
}
