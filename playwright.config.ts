import { defineConfig } from '@playwright/test';

// Set E2E_BASE_URL to test an already-running deployment (e.g. the Docker image).
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: external ?? 'http://localhost:4173' },
  webServer: external
    ? undefined
    : {
        command: 'npm run build && npx vite preview --port 4173 --strictPort',
        port: 4173,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
