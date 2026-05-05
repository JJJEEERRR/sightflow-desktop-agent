import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/main/**/*.{test,spec}.ts',
            'src/preload/**/*.{test,spec}.ts',
            'src/core/**/*.{test,spec}.ts',
            'tests/**/*.{test,spec}.ts'
          ],
          setupFiles: ['tests/setup.node.ts']
        }
      },
      {
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.jsdom.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/renderer/src/main.tsx',
        'src/renderer/src/env.d.ts',
        'src/preload/index.d.ts',
        'src/core/rpa/tests/**'
      ],
      thresholds: {
        // Global floor for the testable surface. Set just below the current
        // measured aggregate (44.79 / 83 / 56.56 / 44.79) so any regression
        // fails CI. Cannot go to 100 — many files (Electron entry, native
        // input/screenshot, etc.) need a real Electron runtime to exercise.
        // Per-file targets for tightly-tested modules are documented in
        // tests/README.md; tighten this floor as more areas become testable.
        lines: 40,
        statements: 40,
        functions: 50,
        branches: 75
      }
    }
  }
})
