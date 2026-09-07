import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'to-*/vitest.config.ts',
      {
        test: {
          name: 'scripts',
          root: './scripts',
          include: ['__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
