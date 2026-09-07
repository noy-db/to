import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'store-browser-fs',
    include: ['__tests__/**/*.test.ts'],
    environment: 'happy-dom',
  },
})
