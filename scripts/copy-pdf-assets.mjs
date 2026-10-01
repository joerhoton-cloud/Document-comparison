// Copies PDF.js and OCR assets into public/ so the app never fetches anything
// from a CDN: PDF.js fonts, character maps and image decoders, plus the
// Tesseract worker, WebAssembly engine and English language model.
// Runs automatically before dev and build.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = (name) => dirname(require.resolve(`${name}/package.json`));
const pub = join(import.meta.dirname, '..', 'public');

// PDF.js
const pdfjs = pkg('pdfjs-dist');
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(pdfjs, dir), join(pub, 'pdfjs', dir), { recursive: true });

// Tesseract OCR
const ocr = join(pub, 'ocr');
mkdirSync(join(ocr, 'core'), { recursive: true });
mkdirSync(join(ocr, 'lang'), { recursive: true });
cpSync(join(pkg('tesseract.js'), 'dist', 'worker.min.js'), join(ocr, 'worker.min.js'));
const core = pkg('tesseract.js-core');
// The worker picks the LSTM build matching the browser's SIMD support.
for (const f of readdirSync(core)) if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.(wasm|wasm\.js|js)$/.test(f)) cpSync(join(core, f), join(ocr, 'core', f));
// "best_int": the accurate LSTM model, integer-quantised (~3 MB).
cpSync(join(pkg('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), join(ocr, 'lang', 'eng.traineddata.gz'));

console.log('Copied PDF.js and OCR assets to public/');
