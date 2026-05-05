import { describe, expect, it } from 'vitest'
import { RingBufferSink } from './ring-buffer-sink'
import type { LogRecord } from '../types'

function makeRecord(msg: string): LogRecord {
  return {
    ts: new Date().toISOString(),
    level: 'info',
    phase: 'test',
    msg
  }
}

describe('RingBufferSink', () => {
  it('getAll() returns empty array when buffer is empty', () => {
    const sink = new RingBufferSink()
    expect(sink.getAll()).toEqual([])
  })

  it('getAll() returns records in insertion order after 5 writes', () => {
    const sink = new RingBufferSink({ size: 1000 })
    const records = [1, 2, 3, 4, 5].map((n) => makeRecord(`msg-${n}`))
    for (const r of records) sink.write(r)

    const all = sink.getAll()
    expect(all).toHaveLength(5)
    expect(all.map((r) => r.msg)).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5'])
  })

  it('wraps around and keeps last N when more than capacity written', () => {
    const sink = new RingBufferSink({ size: 1000 })
    for (let i = 1; i <= 1500; i++) sink.write(makeRecord(`msg-${i}`))

    const all = sink.getAll()
    expect(all).toHaveLength(1000)
    expect(all[0].msg).toBe('msg-501')
    expect(all[999].msg).toBe('msg-1500')
  })

  it('drainSince(0) returns all records with nextIdx equal to total written', () => {
    const sink = new RingBufferSink({ size: 1000 })
    for (let i = 1; i <= 5; i++) sink.write(makeRecord(`msg-${i}`))

    const { records, nextIdx } = sink.drainSince(0)
    expect(records).toHaveLength(5)
    expect(nextIdx).toBe(5)
  })

  it('drainSince(idx) returns only records written after idx', () => {
    const sink = new RingBufferSink({ size: 1000 })
    for (let i = 1; i <= 10; i++) sink.write(makeRecord(`msg-${i}`))

    const { records, nextIdx } = sink.drainSince(7)
    expect(records).toHaveLength(3)
    expect(records[0].msg).toBe('msg-8')
    expect(records[2].msg).toBe('msg-10')
    expect(nextIdx).toBe(10)
  })

  it('clear() resets the buffer', () => {
    const sink = new RingBufferSink({ size: 100 })
    for (let i = 0; i < 10; i++) sink.write(makeRecord('x'))
    sink.clear()
    expect(sink.getAll()).toEqual([])
    const { records, nextIdx } = sink.drainSince(0)
    expect(records).toHaveLength(0)
    expect(nextIdx).toBe(0)
  })

  it('default size is 1000', () => {
    const sink = new RingBufferSink()
    for (let i = 0; i < 1001; i++) sink.write(makeRecord(`m${i}`))
    expect(sink.getAll()).toHaveLength(1000)
  })
})
