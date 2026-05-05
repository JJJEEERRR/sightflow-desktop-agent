/**
 * Pure logic for building a diagnostics zip.
 *
 * Kept Electron-free so it's unit-testable without booting the app: the
 * caller passes in already-resolved snapshots/redacted settings/runtime info
 * and a real `logsDir` path. The IPC handler in `src/main/index.ts` is the
 * one place that talks to `app.getPath`, `safeStorage`, `BrowserWindow`,
 * etc., and then defers all I/O to `buildDiagnosticsZip` here.
 *
 * Zip layout:
 *   /lifecycle.json
 *   /policy.json
 *   /settings.json
 *   /runtime.json
 *   /recent-logs.json
 *   /logs/                 (only if includeLogs=true; mtime-filtered by daysBack)
 *
 * Redaction policy: this module does NOT redact. The caller is the security
 * boundary (it owns the secrets) and passes in already-redacted settings.
 */

import archiver from 'archiver'
import fs from 'fs'
import path from 'path'
import { getLogger } from '../core/observability'

const log = getLogger('main.diagnostics-export')

export interface DiagnosticsExportInput {
  outputPath: string
  logsDir: string
  daysBack: number
  includeLogs: boolean
  lifecycleSnapshot: unknown
  policySnapshot: unknown
  settingsRedacted: Record<string, unknown>
  recentLogs: unknown[]
  runtimeInfo: Record<string, unknown>
}

export interface DiagnosticsExportResult {
  path: string
  sizeBytes: number
}

/**
 * Returns the list of `*.jsonl` files under `logsDir` whose mtime is within
 * the last `daysBack` days. Returns an empty list if the directory does not
 * exist (rather than throwing); the diagnostics export should still succeed
 * if the user has never produced a log file.
 *
 * Exported so the IPC handler can preflight or so tests can pin behaviour.
 */
export function listRecentLogFiles(
  logsDir: string,
  daysBack: number,
  now: Date = new Date()
): string[] {
  if (!fs.existsSync(logsDir)) return []
  const cutoff = now.getTime() - daysBack * 24 * 60 * 60 * 1000
  let entries: string[]
  try {
    entries = fs.readdirSync(logsDir)
  } catch (err) {
    log.warn('failed to read logs directory', { err, logsDir })
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(logsDir, name)
    try {
      const st = fs.statSync(full)
      if (st.mtimeMs >= cutoff) out.push(full)
    } catch (err) {
      log.warn('failed to stat log file', { err, file: full })
    }
  }
  return out
}

/**
 * Stream-builds the diagnostics zip at `input.outputPath`. Resolves with the
 * final on-disk size once the archive is fully flushed.
 *
 * On any archiver/writer error the promise rejects; the caller is expected
 * to map that to a `{ success: false, error }` IPC response.
 */
export function buildDiagnosticsZip(
  input: DiagnosticsExportInput
): Promise<DiagnosticsExportResult> {
  return new Promise<DiagnosticsExportResult>((resolve, reject) => {
    const dir = path.dirname(input.outputPath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const output = fs.createWriteStream(input.outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    output.on('close', () => {
      settle(() => {
        resolve({ path: input.outputPath, sizeBytes: archive.pointer() })
      })
    })

    output.on('error', (err) => {
      settle(() => reject(err))
    })

    archive.on('warning', (err) => {
      // ENOENT etc. on a single log file shouldn't kill the whole export.
      // We log and keep going; archiver itself decides whether to continue.
      log.warn('archiver warning', { err })
    })

    archive.on('error', (err) => {
      settle(() => reject(err))
    })

    archive.pipe(output)

    const writeJson = (name: string, value: unknown): void => {
      archive.append(JSON.stringify(value, null, 2), { name })
    }

    writeJson('lifecycle.json', input.lifecycleSnapshot ?? null)
    writeJson('policy.json', input.policySnapshot ?? null)
    writeJson('settings.json', input.settingsRedacted)
    writeJson('runtime.json', input.runtimeInfo)
    writeJson('recent-logs.json', input.recentLogs)

    if (input.includeLogs) {
      const files = listRecentLogFiles(input.logsDir, input.daysBack)
      for (const file of files) {
        archive.file(file, { name: `logs/${path.basename(file)}` })
      }
    }

    archive.finalize().catch((err) => {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))))
    })
  })
}
