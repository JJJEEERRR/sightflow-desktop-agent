// i18next runtime + bundled resources for the renderer.
//
// Replaces the homegrown `src/renderer/src/i18n.ts` (≈274 LOC) with a
// thin wrapper around the standard `i18next` + `react-i18next` stack.
// Resources are statically imported and synchronous — no language
// detector, no http-backend, no Suspense, no async load.
//
// The dictionary keys mirror the legacy flat-string format
// (e.g. `'control.start.nokey'`) verbatim; setting `keySeparator: false`
// disables i18next's default dot-walking so a key like `control.start`
// (which is also a *prefix* of `control.start.nokey` in the legacy
// table) doesn't collide with its sibling. Same for `settings.apiKey`
// vs `settings.apiKey.placeholder`, `diag.export` vs `diag.export.aria`,
// `control.log` vs `control.log.empty`, etc.

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '../locales/zh.json'
import en from '../locales/en.json'

const STORAGE_KEY = 'sightflow.locale'

function readStoredLocale(): 'zh' | 'en' {
  if (typeof window === 'undefined') return 'zh'
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY)
    return stored === 'en' ? 'en' : 'zh'
  } catch {
    // localStorage can throw in jsdom under restricted security policies;
    // default silently in that case.
    return 'zh'
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en }
  },
  lng: readStoredLocale(),
  // The two dictionaries are paired 1:1 by construction (PR3 verified
  // every legacy zh key has an en counterpart). A missing key is a real
  // bug — surfacing the key string in dev is louder than silently
  // falling back to the other locale.
  fallbackLng: false,
  // Disable i18next's dot-walking. Our keys are flat strings that
  // historically encoded their hierarchy in the dot-suffix (e.g.
  // `control.start` AND `control.start.nokey` coexist as siblings).
  keySeparator: false,
  // Same reasoning for `:` — we don't use a namespace separator either.
  nsSeparator: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false }
})

export type Locale = 'zh' | 'en'

export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale)
  try {
    window.localStorage?.setItem(STORAGE_KEY, locale)
  } catch {
    // localStorage unavailable (jsdom under stricter policies, or a
    // user who disabled storage) — silent.
  }
}

export function getCurrentLocale(): Locale {
  return i18n.language === 'en' ? 'en' : 'zh'
}

/** Backwards-compatible alias for the legacy `i18n.ts` API surface. */
export const getLocale = getCurrentLocale

export default i18n
