import { defineConfig } from 'vitest/config';

// Server integration tests need Postgres: TEST_DATABASE_URL (default: local dev instance).
export default defineConfig({
  test: {
    include: ['tests/server/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:3000',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/doccompare_test',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    },
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
