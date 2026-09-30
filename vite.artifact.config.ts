import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Swap the PDF worker loader for the embedded (blob URL) variant. */
const inlineWorker = (): Plugin => ({
  name: 'inline-pdf-worker',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === './pdfWorker' && importer?.includes('/src/extract/')) return resolve(__dirname, 'src/extract/pdfWorker.inline.ts');
    return null;
  },
});

// Single-file build (`npm run build:single`): everything in one HTML page.
export default defineConfig({
  mode: 'artifact',
  plugins: [inlineWorker()],
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist-single',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
