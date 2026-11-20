import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Main and preload use relative imports (so tsx and vitest need no alias config).
// The renderer uses @renderer / @shared / @core aliases.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core')
      }
    },
    plugins: [react()]
  }
})
