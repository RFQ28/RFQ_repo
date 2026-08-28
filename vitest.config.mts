import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      // `server-only` throws outside a React Server Component build. The guard
      // is for the bundler, not for us -- these modules are server code either
      // way, and the tests exercise them directly.
      'server-only': resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
    },
  },
})
