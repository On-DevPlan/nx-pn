import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
    environment: 'node',
    passWithNoTests: true,
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
})
