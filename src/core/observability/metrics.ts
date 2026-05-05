import type { MetricsSnapshot, HistogramSnapshot } from './types'

const HISTOGRAM_MAX_SIZE = 1024

function buildLabelKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')
  return `${name}{${sorted}}`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

interface HistogramData {
  values: number[]
  head: number
  count: number
  sum: number
}

export class Metrics {
  private counters: Map<string, number>
  private histograms: Map<string, HistogramData>

  constructor() {
    this.counters = new Map()
    this.histograms = new Map()
  }

  counter(name: string, labels?: Record<string, string>, delta?: number): void {
    const key = buildLabelKey(name, labels)
    const inc = delta ?? 1
    this.counters.set(key, (this.counters.get(key) ?? 0) + inc)
  }

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = buildLabelKey(name, labels)
    let h = this.histograms.get(key)
    if (!h) {
      h = {
        values: new Array<number>(HISTOGRAM_MAX_SIZE),
        head: 0,
        count: 0,
        sum: 0
      }
      this.histograms.set(key, h)
    }
    h.values[h.head] = value
    h.head = (h.head + 1) % HISTOGRAM_MAX_SIZE
    h.count++
    h.sum += value
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {}
    for (const [k, v] of this.counters) {
      counters[k] = v
    }

    const histograms: Record<string, HistogramSnapshot> = {}
    for (const [k, h] of this.histograms) {
      const storedCount = Math.min(h.count, HISTOGRAM_MAX_SIZE)
      const raw: number[] = []
      if (h.count <= HISTOGRAM_MAX_SIZE) {
        for (let i = 0; i < storedCount; i++) {
          raw.push(h.values[i])
        }
      } else {
        // Buffer is full, oldest is at head
        for (let i = 0; i < HISTOGRAM_MAX_SIZE; i++) {
          raw.push(h.values[(h.head + i) % HISTOGRAM_MAX_SIZE])
        }
      }
      const sorted = [...raw].sort((a, b) => a - b)

      const storedMin = sorted.length > 0 ? sorted[0] : 0
      const storedMax = sorted.length > 0 ? sorted[sorted.length - 1] : 0

      histograms[k] = {
        count: h.count,
        sum: h.sum,
        min: storedMin,
        max: storedMax,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95)
      }
    }

    return {
      counters,
      histograms,
      takenAt: new Date().toISOString()
    }
  }

  reset(): void {
    this.counters.clear()
    this.histograms.clear()
  }
}

export const metrics: Metrics = new Metrics()
