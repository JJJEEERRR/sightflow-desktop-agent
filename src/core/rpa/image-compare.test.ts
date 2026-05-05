import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'

import { compareImages, hasImageChanged } from './image-compare'

/**
 * Build a fake `Electron.NativeImage` that exposes only the surface
 * `compareImages` actually consumes (`toPNG()` returning a `Buffer`). This
 * lets the unit tests run outside of an Electron runtime.
 */
function fakeNativeImage(width: number, height: number, fillRgba: number): Electron.NativeImage {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (fillRgba >>> 24) & 0xff // R
    png.data[i + 1] = (fillRgba >>> 16) & 0xff // G
    png.data[i + 2] = (fillRgba >>> 8) & 0xff // B
    png.data[i + 3] = fillRgba & 0xff // A
  }
  const buf = PNG.sync.write(png)
  // Electron.NativeImage has dozens of methods — we only stub `toPNG`. Cast via
  // unknown so TypeScript stops fretting about the missing surface.
  return { toPNG: () => buf } as unknown as Electron.NativeImage
}

function fakeNativeImageWithStripe(
  width: number,
  height: number,
  bg: number,
  stripeColor: number,
  stripePixels: number
): Electron.NativeImage {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    const pixelIndex = i / 4
    const colour = pixelIndex < stripePixels ? stripeColor : bg
    png.data[i] = (colour >>> 24) & 0xff
    png.data[i + 1] = (colour >>> 16) & 0xff
    png.data[i + 2] = (colour >>> 8) & 0xff
    png.data[i + 3] = colour & 0xff
  }
  const buf = PNG.sync.write(png)
  return { toPNG: () => buf } as unknown as Electron.NativeImage
}

describe('compareImages', () => {
  it('reports identical images as zero diff', () => {
    const a = fakeNativeImage(10, 10, 0xffffffff) // opaque white
    const b = fakeNativeImage(10, 10, 0xffffffff)
    const r = compareImages(a, b)
    expect(r.identical).toBe(true)
    expect(r.diffPixelCount).toBe(0)
    expect(r.diffPercentage).toBe(0)
    expect(r.hasChanged).toBe(false)
    expect(r.totalPixels).toBe(100)
  })

  it('flags a pure-color flip as 100% changed', () => {
    const white = fakeNativeImage(10, 10, 0xffffffff)
    const red = fakeNativeImage(10, 10, 0xff0000ff)
    const r = compareImages(white, red)
    expect(r.identical).toBe(false)
    expect(r.diffPixelCount).toBe(100)
    expect(r.hasChanged).toBe(true)
  })

  it('returns hasChanged=true on size mismatch', () => {
    const a = fakeNativeImage(10, 10, 0xffffffff)
    const b = fakeNativeImage(20, 20, 0xffffffff)
    const r = compareImages(a, b)
    expect(r.hasChanged).toBe(true)
    expect(r.diffPercentage).toBe(100)
    expect(r.identical).toBe(false)
  })

  it('respects the changeThreshold for small diffs', () => {
    // 100x100 image with 5% of pixels different. Default changeThreshold is 0.5%
    // so this must register as changed; with changeThreshold=10 it must not.
    const baseline = fakeNativeImage(100, 100, 0xffffffff)
    const altered = fakeNativeImageWithStripe(100, 100, 0xffffffff, 0x000000ff, 500)

    const tight = compareImages(baseline, altered)
    expect(tight.hasChanged).toBe(true)
    expect(tight.diffPercentage).toBeGreaterThan(0)
    expect(tight.diffPercentage).toBeLessThanOrEqual(5.5)

    const loose = compareImages(baseline, altered, { changeThreshold: 10 })
    expect(loose.hasChanged).toBe(false)
    expect(loose.identical).toBe(false) // still has *some* diff
  })
})

describe('hasImageChanged', () => {
  it('is a thin wrapper around compareImages.hasChanged', () => {
    const a = fakeNativeImage(8, 8, 0xffffffff)
    const b = fakeNativeImage(8, 8, 0xffffffff)
    expect(hasImageChanged(a, b)).toBe(false)

    const c = fakeNativeImage(8, 8, 0x000000ff)
    expect(hasImageChanged(a, c)).toBe(true)
  })
})
