import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { JsonFileSink } from './json-file-sink'
import type { LogRecord } from '../types'
import fs from 'fs'
import path from 'path'
import os from 'os'

function makeRecord(msg: string, ts?: string): LogRecord {
  return {
    ts: ts ?? new Date().toISOString(),
    level: 'info',
    phase: 'test',
    msg
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sightflow-test-'))
}

let dir: string

beforeEach(() => {
  dir = tmpDir()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('JsonFileSink', () => {
  it('creates the directory if it does not exist', () => {
    const subDir = path.join(dir, 'deeply', 'nested')
    const sink = new JsonFileSink({ dir: subDir, dailyRotation: false })
    sink.write(makeRecord('hello'))
    expect(fs.existsSync(subDir)).toBe(true)
  })

  it('writes records as newline-delimited JSON', () => {
    const sink = new JsonFileSink({ dir, dailyRotation: false })
    sink.write(makeRecord('record1'))
    sink.write(makeRecord('record2'))

    const files = fs.readdirSync(dir)
    expect(files).toHaveLength(1)
    const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).msg).toBe('record1')
    expect(JSON.parse(lines[1]).msg).toBe('record2')
  })

  it('uses YYYY-MM-DD suffix in filename when dailyRotation is true', () => {
    const sink = new JsonFileSink({ dir, dailyRotation: true })
    sink.write(makeRecord('hello'))
    const files = fs.readdirSync(dir)
    expect(files[0]).toMatch(/^sightflow-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('uses filename sightflow-current.jsonl when dailyRotation is false', () => {
    const sink = new JsonFileSink({ dir, dailyRotation: false })
    sink.write(makeRecord('hello'))
    const files = fs.readdirSync(dir)
    expect(files[0]).toBe('sightflow-current.jsonl')
  })

  it('prunes files older than maxDays on day change', () => {
    // Create an old file manually
    const oldDate = new Date()
    oldDate.setUTCDate(oldDate.getUTCDate() - 35)
    const y = oldDate.getUTCFullYear()
    const m = String(oldDate.getUTCMonth() + 1).padStart(2, '0')
    const d = String(oldDate.getUTCDate()).padStart(2, '0')
    const oldFile = path.join(dir, `sightflow-${y}-${m}-${d}.jsonl`)
    fs.writeFileSync(oldFile, '{"old":true}\n')

    const sink = new JsonFileSink({ dir, dailyRotation: true, maxDays: 30 })
    sink.write(makeRecord('trigger'))

    // Write a second record to force the pruning logic
    // (pruning happens when the day changes; we simulate by using the internal state)
    expect(fs.existsSync(oldFile)).toBe(false)
  })

  it('flush() resolves without error', async () => {
    const sink = new JsonFileSink({ dir, dailyRotation: false })
    await expect(sink.flush()).resolves.toBeUndefined()
  })

  it('does not throw when write fails (e.g., read-only dir)', () => {
    // Skip this test on Windows where chmod has limited effect
    if (process.platform === 'win32') return

    const roDir = path.join(dir, 'readonly')
    fs.mkdirSync(roDir)
    fs.chmodSync(roDir, 0o444)

    const sink = new JsonFileSink({ dir: roDir, dailyRotation: false })
    // Should not throw — logs to console and drops the record
    expect(() => sink.write(makeRecord('test'))).not.toThrow()

    fs.chmodSync(roDir, 0o755)
  })
})
