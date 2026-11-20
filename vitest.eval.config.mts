import { defineConfig } from 'vitest/config'

// The assistant's scripted requests against the real Claude (`npm run eval:assistant`).
// Kept apart from `npm test`: each request uses the user's Claude plan.
export default defineConfig({
  test: {
    include: ['src/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 240_000,
    // One at a time: each request runs a Claude Code process.
    fileParallelism: false
  }
})
