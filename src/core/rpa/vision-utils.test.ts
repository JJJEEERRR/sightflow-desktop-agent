import { describe, expect, it, beforeEach } from 'vitest'
import {
  parseBBoxes,
  parsePoint,
  bboxToScreenCoords,
  pointToScreenCoords,
  bboxToCropBounds,
  getLayoutCache,
  setLayoutCache,
  clearLayoutCache,
  type BBox,
  type LayoutCache
} from './vision-utils'

const sampleBounds = { x: 100, y: 200, width: 800, height: 600 }

describe('parseBBoxes', () => {
  it('parses comma-separated bbox tags', () => {
    const text = 'sure: <bbox>120,80,260,200</bbox> done'
    expect(parseBBoxes(text)).toEqual<BBox[]>([[120, 80, 260, 200]])
  })

  it('parses space-separated bbox tags as a fallback', () => {
    const text = '<bbox>10 20 30 40</bbox>'
    expect(parseBBoxes(text)).toEqual<BBox[]>([[10, 20, 30, 40]])
  })

  it('parses multiple comma-separated bboxes in order', () => {
    const text =
      'first <bbox>1,2,3,4</bbox> second <bbox>10,20,30,40</bbox> third <bbox>100,200,300,400</bbox>'
    expect(parseBBoxes(text)).toEqual<BBox[]>([
      [1, 2, 3, 4],
      [10, 20, 30, 40],
      [100, 200, 300, 400]
    ])
  })

  it('rounds floating point coordinates', () => {
    expect(parseBBoxes('<bbox>1.4,2.6,3.5,4.5</bbox>')).toEqual<BBox[]>([[1, 3, 4, 5]])
  })

  it('returns [] for empty / undefined input', () => {
    expect(parseBBoxes('')).toEqual([])
    expect(parseBBoxes('no tags here')).toEqual([])
  })

  it('skips bboxes containing non-finite numbers', () => {
    // Number(' ') is 0 which is finite, so we use a guaranteed NaN source. The regex
    // requires digits, so this test asserts the parser does not crash on garbage.
    expect(parseBBoxes('<bbox>1.0,bad,3,4</bbox>')).toEqual([])
  })

  it('does not mix space and comma matches in one document', () => {
    // Once a comma-separated match is found, the parser stops looking for space-separated.
    const text = '<bbox>1,2,3,4</bbox> <bbox>10 20 30 40</bbox>'
    expect(parseBBoxes(text)).toEqual<BBox[]>([[1, 2, 3, 4]])
  })
})

describe('parsePoint', () => {
  it('parses space-separated <point>', () => {
    expect(parsePoint('<point>500 250</point>')).toEqual([500, 250])
  })

  it('parses comma-separated <point>', () => {
    expect(parsePoint('<point>500,250</point>')).toEqual([500, 250])
  })

  it('returns null when no point tag is present', () => {
    expect(parsePoint('plain text')).toBeNull()
    expect(parsePoint('')).toBeNull()
  })

  it('rounds floats', () => {
    expect(parsePoint('<point>123.4 567.6</point>')).toEqual([123, 568])
  })
})

describe('bboxToScreenCoords', () => {
  // The function branches on process.platform === 'win32'. We test the branch that
  // matches the host so this suite passes on both CI runners (Win + macOS).
  const isWindows = process.platform === 'win32'

  it('maps a centered bbox to the window centre + bounds offset', () => {
    // bbox covers the entire normalised window (0-1000), so centre is 500,500
    // → logical centre = bounds.width/2, bounds.height/2 = 400, 300
    const bbox: BBox = [0, 0, 1000, 1000]
    const [x, y] = bboxToScreenCoords(bbox, sampleBounds, 1)

    if (isWindows) {
      // Windows: physical pixels = (bounds.x + logicalX) * scaleFactor
      expect(x).toBe(500) // (100 + 400) * 1
      expect(y).toBe(500) // (200 + 300) * 1
    } else {
      expect(x).toBe(500)
      expect(y).toBe(500)
    }
  })

  it('applies scaleFactor only on Windows', () => {
    const bbox: BBox = [400, 400, 600, 600] // centre 500,500 normalised
    const [x, y] = bboxToScreenCoords(bbox, sampleBounds, 2)

    if (isWindows) {
      // logical centre = 400, 300; with scale=2 → (100+400)*2=1000, (200+300)*2=1000
      expect(x).toBe(1000)
      expect(y).toBe(1000)
    } else {
      // mac ignores scaleFactor for robotjs
      expect(x).toBe(500)
      expect(y).toBe(500)
    }
  })
})

describe('pointToScreenCoords', () => {
  const isWindows = process.platform === 'win32'

  it('maps the upper-left corner correctly', () => {
    const [x, y] = pointToScreenCoords([0, 0], sampleBounds, 1)
    expect(x).toBe(100) // bounds.x
    expect(y).toBe(200) // bounds.y
  })

  it('maps the lower-right corner correctly', () => {
    const [x, y] = pointToScreenCoords([1000, 1000], sampleBounds, 1)
    expect(x).toBe(900) // bounds.x + width
    expect(y).toBe(800) // bounds.y + height
  })

  it('applies scaleFactor only on Windows', () => {
    const [x, y] = pointToScreenCoords([500, 500], sampleBounds, 2)
    if (isWindows) {
      expect(x).toBe(1000) // (100 + 400) * 2
      expect(y).toBe(1000) // (200 + 300) * 2
    } else {
      expect(x).toBe(500)
      expect(y).toBe(500)
    }
  })
})

describe('bboxToCropBounds', () => {
  it('converts normalised bbox to logical-pixel rect', () => {
    const r = bboxToCropBounds([100, 100, 200, 200], { width: 1000, height: 1000 })
    expect(r).toEqual({ x: 100, y: 100, width: 100, height: 100 })
  })

  it('handles inverted bbox (x2 < x1) by taking absolute size and minimal origin', () => {
    const r = bboxToCropBounds([300, 300, 100, 100], { width: 1000, height: 1000 })
    expect(r).toEqual({ x: 100, y: 100, width: 200, height: 200 })
  })

  it('scales bbox to the actual window dimensions', () => {
    // bbox 0-1000 covers full window
    const r = bboxToCropBounds([0, 0, 1000, 1000], { width: 800, height: 600 })
    expect(r).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })
})

describe('LayoutCache get/set/clear', () => {
  beforeEach(() => {
    clearLayoutCache('weixin')
    clearLayoutCache('wework')
  })

  it('returns null when no cache has been set', () => {
    expect(getLayoutCache('weixin')).toBeNull()
  })

  it('stores and retrieves a cache entry per appType', () => {
    const cache: LayoutCache = emptyCache('weixin')
    setLayoutCache('weixin', cache)
    expect(getLayoutCache('weixin')).toBe(cache)
    expect(getLayoutCache('wework')).toBeNull()
  })

  it('clearLayoutCache removes the entry for the given appType only', () => {
    const w = emptyCache('weixin')
    const x = emptyCache('wework')
    setLayoutCache('weixin', w)
    setLayoutCache('wework', x)
    clearLayoutCache('weixin')
    expect(getLayoutCache('weixin')).toBeNull()
    expect(getLayoutCache('wework')).toBe(x)
  })
})

function emptyCache(appType: 'weixin' | 'wework'): LayoutCache {
  return {
    chatEntranceArea: null,
    firstContact: null,
    searchInputBox: null,
    headerArea: null,
    chatMainArea: null,
    messageInputArea: null,
    timestamp: 0,
    appType
  }
}
