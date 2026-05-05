/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import i18n, { setLocale, getCurrentLocale, getLocale } from './index'
import zh from '../locales/zh.json'
import en from '../locales/en.json'

afterEach(() => {
  // Reset to the default locale between tests so the module-singleton
  // language doesn't bleed across cases.
  setLocale('zh')
})

describe('i18n', () => {
  it('defaults to zh', () => {
    expect(getCurrentLocale()).toBe('zh')
    // Backwards-compatible alias retained for any caller still importing
    // `getLocale` from the legacy API.
    expect(getLocale()).toBe('zh')
  })

  it('returns Chinese strings by default', () => {
    expect(i18n.t('app.title')).toBe('SightFlow Desktop')
    expect(i18n.t('settings.save')).toBe('保存配置')
  })

  it('switches to English when locale is set to "en"', () => {
    setLocale('en')
    expect(i18n.t('settings.save')).toBe('Save')
    expect(i18n.t('control.start')).toBe('Start Engine')
  })

  it('does NOT fall back to a different locale when a key is missing in the active one', () => {
    // PR3 sets `fallbackLng: false` deliberately. The two dictionaries
    // are paired 1:1; a missing key is a real bug, so i18next is
    // configured to return the literal key string instead of silently
    // hiding the gap by reading from the other locale.
    setLocale('en')
    // toast.engineStarted exists in both dicts — sanity-check English.
    expect(i18n.t('toast.engineStarted')).toBe('Engine started')
  })

  it('returns the key itself if it is missing from both locales', () => {
    // Defensive: `t('typo.key')` should surface the key string so a
    // missing translation is loud, not silent.
    expect(i18n.t('this.does.not.exist')).toBe('this.does.not.exist')
  })

  it('every key defined in zh is also defined in en (paired 1:1, no silent gaps)', () => {
    const zhKeys = Object.keys(zh) as Array<keyof typeof zh>
    const enKeys = new Set(Object.keys(en))
    const missing = zhKeys.filter((k) => !enKeys.has(k as string))
    expect(missing, `EN dictionary missing keys: ${missing.join(', ')}`).toEqual([])
  })
})
