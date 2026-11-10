import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // A worker intentionally claims the global queue. Independent fixture files
    // must not consume each other's work; concurrent admission tests still use
    // the native PostgreSQL pool inside their own test.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
