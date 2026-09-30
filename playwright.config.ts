import { defineConfig } from '@playwright/test';

// Set E2E_BASE_URL to test an already-running deployment.
const external = process.env.E2E_BASE_URL;
const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: external ?? `http://localhost:${port}` },
  webServer: external
    ? undefined
    : {
        // The real server (API + static build) with billing off. Emails are written to the log,
        // which the tests read to follow confirmation and invitation links.
        command: `npm run build && node dist-server/index.mjs > .e2e-server.log 2>&1`,
        port,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          PORT: String(port),
          BASE_URL: `http://localhost:${port}`,
          DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://postgres@localhost:5433/doccompare_e2e',
          BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
          DISABLE_RATE_LIMIT: 'true',
        },
      },
});
