// Compile-time key safety for `t(...)`. With this augmentation,
// `useTranslation()`'s `t` function (and the imperative `i18n.t`)
// type-checks the key against the bundled zh dictionary, so a typo
// (e.g. `t('control.starrt')`) is a TS error.
//
// We intentionally augment via the *zh* resource: the en dictionary is
// expected to mirror it 1:1 (verified at runtime by `fallbackLng: false`
// surfacing any missing key as the literal key string). Augmenting via
// zh keeps the canonical key set in one place.

import 'react-i18next'
import zh from '../locales/zh.json'

declare module 'react-i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof zh
    }
    // Mirror the runtime `keySeparator: false` setting so the key-type
    // inference treats keys as flat strings rather than dot-walking
    // them into nested object types.
    keySeparator: false
    nsSeparator: false
  }
}
