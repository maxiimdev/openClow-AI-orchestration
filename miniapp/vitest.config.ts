import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, 'app'),
    },
  },
})
