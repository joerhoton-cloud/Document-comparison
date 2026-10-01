// The "legacy" build is the same PDF.js release with compatibility shims, so it
// also runs in browsers that lack the newest JavaScript features.
import { getDocument, GlobalWorkerOptions, PasswordException, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Block } from '../types';
import { ExtractionError } from './errors';
import { createOcr, hasTextLayer, type Ocr } from './ocr';
import { blocksFromPdfItems, type PdfTextItem } from './pdfLayout';
import { pdfAssetBase, workerSrc } from './pdfWorker';

GlobalWorkerOptions.workerSrc = workerSrc;

/** Target width in pixels for pages rendered for OCR (≈ 240 dpi for US Letter). */
const OCR_RENDER_WIDTH = 2000;

export async function blocksFromPdf(
  data: ArrayBuffer,
  name: string,
  onProgress?: (message: string) => void,
): Promise<{ blocks: Block[]; pageCount: number; ocrPages: number }> {
  const task = getDocument({
    data: new Uint8Array(data),
    // Hardening: no scripting, no XFA forms, no remote font/CMap fetching.
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Served from this origin (copied from pdfjs-dist at build time).
    ...(pdfAssetBase && {
      cMapUrl: `${pdfAssetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
      // Decoders for scanned-image formats (JBIG2, JPEG 2000).
      wasmUrl: `${pdfAssetBase}wasm/`,
    }),
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (err instanceof PasswordException) throw new ExtractionError('This PDF is password-protected. Remove the password and try again.');
    throw new ExtractionError('This file could not be read as a PDF.');
  }
  let ocr: Ocr | undefined;
  try {
    const pages: PdfTextItem[][] = [];
    const scanned: number[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const items = content.items.filter((it) => 'str' in it) as PdfTextItem[];
      if (!hasTextLayer(items)) scanned.push(p);
      pages.push(items);
      page.cleanup();
      onProgress?.(`Reading ${name}: page ${p} of ${pdf.numPages}`);
    }

    // Pages without a text layer are scans: render them and recognise the text.
    for (const [i, p] of scanned.entries()) {
      const label = `Recognizing text in ${name} (scanned page ${i + 1} of ${scanned.length})`;
      onProgress?.(`${label}…`);
      ocr ??= await createOcr((f) => onProgress?.(`${label}: ${Math.round(f * 100)}%`));
      const page = await pdf.getPage(p);
      pages[p - 1] = await ocrPage(page, ocr);
      page.cleanup();
    }

    const blocks = blocksFromPdfItems(pages);
    if (!blocks.length) {
      throw new ExtractionError(`No readable text was found in ${name}, even with text recognition. Check the scan isn't blank or very low quality.`);
    }
    return { blocks, pageCount: pdf.numPages, ocrPages: scanned.length };
  } finally {
    await ocr?.terminate();
    await task.destroy();
  }
}

async function ocrPage(page: PDFPageProxy, ocr: Ocr): Promise<PdfTextItem[]> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(1.5, OCR_RENDER_WIDTH / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvas, viewport }).promise;
    return await ocr.recognize(canvas, base.height, scale);
  } finally {
    // Free the bitmap right away; scans can be large.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** OCR a photo or scan saved as an image (PNG, JPEG, WebP). */
export async function blocksFromImage(file: File, onProgress?: (message: string) => void): Promise<Block[]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ExtractionError(`${file.name} could not be opened as an image.`);
  }
  // Upscale small images and cap very large ones; Tesseract works best around 2000–3000 px wide.
  const scale = Math.min(3, Math.max(1, OCR_RENDER_WIDTH / bitmap.width), 4000 / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const label = `Recognizing text in ${file.name}`;
  onProgress?.(`${label}…`);
  const ocr = await createOcr((f) => onProgress?.(`${label}: ${Math.round(f * 100)}%`));
  try {
    // Work in image pixels as "points" (scale 1 at the original size).
    const items = await ocr.recognize(canvas, bitmap.height || canvas.height / scale, scale);
    const blocks = blocksFromPdfItems([items]);
    if (!blocks.length) throw new ExtractionError(`No readable text was found in ${file.name}.`);
    return blocks;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await ocr.terminate();
  }
}
