import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  // `npm run dev:server` serves the API on :3000.
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
