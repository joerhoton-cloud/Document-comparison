// Copies PDF.js font and character-map data into public/ so the app never
// needs to fetch them from a CDN. Runs automatically before dev and build.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const out = join(import.meta.dirname, '..', 'public', 'pdfjs');
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(root, dir), join(out, dir), { recursive: true });
console.log('Copied PDF.js cmaps and standard fonts to public/pdfjs');
