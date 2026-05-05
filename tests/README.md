# Tests

Run all tests:

```bash
npm test                # one-shot
npm run test:watch      # interactive watch mode
npm run test:coverage   # with v8 coverage report (text + lcov + html)
```

The test suite is organised into two Vitest projects (`vitest.config.ts`):

| Project | Environment | Files                                                      |
| ------- | ----------- | ---------------------------------------------------------- |
| `node`  | Node.js     | `src/main/**`, `src/preload/**`, `src/core/**`, `tests/**` |
| `jsdom` | jsdom       | `src/renderer/**`                                          |

Renderer tests opt into jsdom either by living in `src/renderer/` (config
match) **or** by carrying a `/** @vitest-environment jsdom */` header. They
must `import '@testing-library/jest-dom/vitest'` at the top of the file to
register custom matchers like `toBeInTheDocument`.

## Coverage targets (per file)

The global threshold in `vitest.config.ts` is intentionally conservative
because many files require Electron/native runtime to exercise. The numbers
below are the bar each tightly-tested module is expected to maintain:

| File                            | Lines | Functions | Branches | Notes                                              |
| ------------------------------- | ----- | --------- | -------- | -------------------------------------------------- |
| `src/core/ai-client.ts`         | ≥ 90  | ≥ 90      | ≥ 85     | Mocked `fetch` covers all error/timeout/SKIP paths |
| `src/core/engine.ts`            | ≥ 85  | ≥ 85      | ≥ 75     | FakeDevice + FakeHooks drive the full main loop    |
| `src/core/local-hooks.ts`       | ≥ 75  | ≥ 50      | ≥ 90     | Mocked `AIClient`                                  |
| `src/core/rpa/util.ts`          | ≥ 85  | ≥ 90      | ≥ 75     | Fake timers for delay helpers                      |
| `src/core/rpa/image-compare.ts` | ≥ 65  | ≥ 30      | ≥ 70     | Synthetic PNGs                                     |
| `src/core/rpa/vision-utils.ts`  | ≥ 50  | ≥ 60      | ≥ 85     | Pure parsers + coord conversions                   |
| `src/core/rpa/window-utils.ts`  | ≥ 30  | ≥ 10      | ≥ 80     | Only `matchWechatType` is pure                     |
| `src/renderer/src/i18n.ts`      | ≥ 95  | ≥ 95      | ≥ 95     | Pure dictionary lookup                             |
| `src/renderer/src/App.tsx`      | ≥ 80  | ≥ 60      | ≥ 80     | RTL + jsdom; mocked `window.electron` IPC          |

## Untested files (intentional)

These require a real Electron process / native module / WeChat instance and
are exercised via the `Build Verify` GitHub Actions matrix instead:

- `src/main/index.ts` — Electron main entry (IPC handlers, BrowserWindow)
- `src/main/permission.ts` — macOS permission dialogs
- `src/preload/index.ts` — `contextBridge` exposure
- `src/core/rpa-device.ts` — concrete `DesktopDevice` implementation
- `src/core/rpa/has-unread.ts` — full pipeline with VLM + screenshot
- `src/core/rpa/input-utils.ts` — robotjs-driven mouse/keyboard
- `src/core/rpa/screenshot-utils.ts` — `desktopCapturer` + `Jimp`
- `src/core/rpa/tests/*` — manual integration scripts (excluded from coverage)

## Adding a new test

1. Co-locate next to the module under test as `*.test.ts` / `*.test.tsx`.
2. If the module ultimately imports from `electron` or a native add-on, do
   one of:
   - Vitest tree-shaking is enough when only types are imported (rare).
   - `vi.mock('electron', () => ({ ... }))` at the top of the test file.
   - `vi.mock('./screenshot-utils', () => ({ ... }))` etc.
3. For renderer tests, prepend `/** @vitest-environment jsdom */` and
   `import '@testing-library/jest-dom/vitest'`.
4. Run `npm test` until green, then `npm run test:coverage` to verify the
   new lines are exercised.
