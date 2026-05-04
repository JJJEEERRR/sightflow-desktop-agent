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
        lines: 0,
        statements: 0,
        functions: 0,
        branches: 0
      }
    }
  }
})
