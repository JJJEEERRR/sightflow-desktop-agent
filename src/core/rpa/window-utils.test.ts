import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  // window-utils.ts only uses screen.getDisplayMatching at runtime, which we
  // never reach in these unit tests. Provide a stub anyway so any accidental
  // touch fails loudly with a recognisable message.
  screen: {
    getDisplayMatching: vi.fn(() => {
      throw new Error('electron.screen should not be invoked from unit tests')
    })
  }
}))
vi.mock('active-win', () => ({ default: { getOpenWindows: vi.fn() } }))
vi.mock('./screenshot-utils', () => ({ captureWechatWindow: vi.fn() }))

import { matchWechatType } from './window-utils'

describe('matchWechatType', () => {
  it('matches the canonical Chinese WeChat names for "weixin"', () => {
    expect(matchWechatType('微信', 'weixin')).toBe(true)
    expect(matchWechatType('微信.app', 'weixin')).toBe(true)
    expect(matchWechatType('WeChat', 'weixin')).toBe(true)
  })

  it('matches the WeWork names for "wework"', () => {
    expect(matchWechatType('企业微信', 'wework')).toBe(true)
    expect(matchWechatType('企业微信.app', 'wework')).toBe(true)
  })

  it('rejects unrelated process names', () => {
    expect(matchWechatType('Chrome', 'weixin')).toBe(false)
    expect(matchWechatType('Slack.app', 'wework')).toBe(false)
    expect(matchWechatType('', 'weixin')).toBe(false)
  })

  it('does not cross-match weixin and wework', () => {
    expect(matchWechatType('微信', 'wework')).toBe(false)
    expect(matchWechatType('企业微信', 'weixin')).toBe(false)
  })

  it('matches WhatsApp variants when appType is whatsapp (string-cast path)', () => {
    // The function widens AppType to string for the WhatsApp branch — that
    // branch ships a special leading-mark character (U+200E) in the .app/.exe
    // names. Smoke-test all four spellings.
    expect(matchWechatType('\u200EWhatsApp', 'whatsapp' as unknown as 'weixin')).toBe(true)
    expect(matchWechatType('WhatsApp', 'whatsapp' as unknown as 'weixin')).toBe(true)
    expect(matchWechatType('\u200EWhatsApp.exe', 'whatsapp' as unknown as 'weixin')).toBe(true)
    expect(matchWechatType('\u200EWhatsApp.app', 'whatsapp' as unknown as 'weixin')).toBe(true)
  })
})
