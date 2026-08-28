import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * Integration suite. Runs against the real Supabase project, so it is kept out
 * of `npm test` and run deliberately with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup-env.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The tests share one tenant each but hit the same project; running them
    // one at a time keeps failures readable.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      'server-only': resolve(import.meta.dirname, 'tests/stubs/server-only.ts'),
    },
  },
})
