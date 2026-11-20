import { defineConfig } from 'vitest/config'

// Run via `npm test`, which uses Electron's bundled Node (ELECTRON_RUN_AS_NODE=1)
// so better-sqlite3 is loaded with the same native build the app uses.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
