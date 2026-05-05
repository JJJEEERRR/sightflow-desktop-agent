import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildDiagnosticsZip,
  listRecentLogFiles,
  type DiagnosticsExportInput
} from './diagnostics-export'

let tmpRoot: string

function mkLogFile(dir: string, name: string, ageDays: number, content = '{"hello":1}\n'): string {
  const full = path.join(dir, name)
  fs.writeFileSync(full, content, 'utf8')
  const t = Date.now() - ageDays * 24 * 60 * 60 * 1000
  fs.utimesSync(full, t / 1000, t / 1000)
  return full
}

function makeInput(overrides: Partial<DiagnosticsExportInput>): DiagnosticsExportInput {
  return {
    outputPath: path.join(tmpRoot, 'diag.zip'),
    logsDir: path.join(tmpRoot, 'logs'),
    daysBack: 14,
    includeLogs: true,
    lifecycleSnapshot: { state: 'idle' },
    policySnapshot: { breaker: 'closed' },
    settingsRedacted: { model: 'gpt-4o', _redacted: ['apiKey', 'apiKeyEncrypted'] },
    recentLogs: [{ msg: 'hello', level: 'info' }],
    runtimeInfo: { platform: process.platform, version: '1.0.0' },
    ...overrides
  }
}

function isZip(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
  } finally {
    fs.closeSync(fd)
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightflow-diag-'))
  fs.mkdirSync(path.join(tmpRoot, 'logs'), { recursive: true })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('listRecentLogFiles', () => {
  it('returns [] when the logs directory does not exist', () => {
    expect(listRecentLogFiles(path.join(tmpRoot, 'nonexistent'), 14)).toEqual([])
  })

  it('filters by mtime against daysBack and ignores non-jsonl files', () => {
    const dir = path.join(tmpRoot, 'logs')
    const fresh = mkLogFile(dir, 'sightflow-2026-05-05.jsonl', 0)
    mkLogFile(dir, 'sightflow-2026-04-01.jsonl', 30)
    mkLogFile(dir, 'README.txt', 0)

    const result = listRecentLogFiles(dir, 14)
    expect(result).toEqual([fresh])
  })
})

describe('buildDiagnosticsZip', () => {
  it('builds a non-empty zip with PK magic and the requested path', async () => {
    mkLogFile(path.join(tmpRoot, 'logs'), 'sightflow-a.jsonl', 0)
    mkLogFile(path.join(tmpRoot, 'logs'), 'sightflow-b.jsonl', 1)

    const result = await buildDiagnosticsZip(makeInput({}))

    expect(result.path).toBe(path.join(tmpRoot, 'diag.zip'))
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(fs.existsSync(result.path)).toBe(true)
    expect(fs.statSync(result.path).size).toBe(result.sizeBytes)
    expect(isZip(result.path)).toBe(true)
  })

  it('produces a smaller zip when includeLogs=false', async () => {
    const big = 'x'.repeat(50_000) + '\n'
    mkLogFile(path.join(tmpRoot, 'logs'), 'sightflow-big.jsonl', 0, big)

    const withLogs = await buildDiagnosticsZip(
      makeInput({ outputPath: path.join(tmpRoot, 'with.zip') })
    )
    const withoutLogs = await buildDiagnosticsZip(
      makeInput({ outputPath: path.join(tmpRoot, 'without.zip'), includeLogs: false })
    )

    expect(withoutLogs.sizeBytes).toBeLessThan(withLogs.sizeBytes)
  })

  it('excludes log files older than daysBack', async () => {
    const dir = path.join(tmpRoot, 'logs')
    mkLogFile(dir, 'sightflow-fresh.jsonl', 0, 'x'.repeat(20_000) + '\n')
    mkLogFile(dir, 'sightflow-old.jsonl', 7, 'y'.repeat(20_000) + '\n')

    const allDays = await buildDiagnosticsZip(
      makeInput({ outputPath: path.join(tmpRoot, 'all.zip'), daysBack: 14 })
    )
    const oneDay = await buildDiagnosticsZip(
      makeInput({ outputPath: path.join(tmpRoot, 'one.zip'), daysBack: 1 })
    )

    expect(oneDay.sizeBytes).toBeLessThan(allDays.sizeBytes)
  })

  it('still succeeds when the logs directory is missing', async () => {
    const result = await buildDiagnosticsZip(
      makeInput({
        outputPath: path.join(tmpRoot, 'nologs.zip'),
        logsDir: path.join(tmpRoot, 'does-not-exist'),
        includeLogs: true
      })
    )
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(isZip(result.path)).toBe(true)
  })

  it('creates the parent directory of outputPath if missing', async () => {
    const nested = path.join(tmpRoot, 'a', 'b', 'c', 'diag.zip')
    const result = await buildDiagnosticsZip(makeInput({ outputPath: nested }))
    expect(fs.existsSync(result.path)).toBe(true)
    expect(isZip(result.path)).toBe(true)
  })

  it('writes the verbatim settingsRedacted blob (caller-owned redaction)', async () => {
    const settingsRedacted = {
      model: 'gpt-4o',
      _redacted: ['apiKey', 'apiKeyEncrypted']
    }
    const result = await buildDiagnosticsZip(makeInput({ settingsRedacted }))
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(isZip(result.path)).toBe(true)
  })
})
