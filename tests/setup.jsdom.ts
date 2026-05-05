// jsdom-environment test setup.
// Wires @testing-library/jest-dom matchers into vitest's expect, and
// initializes i18next once per worker so component tests render with a
// translation function ready before any `useTranslation()` call.
import '@testing-library/jest-dom/vitest'
import '../src/renderer/src/i18n'
