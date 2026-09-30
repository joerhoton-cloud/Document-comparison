import { getDocument, GlobalWorkerOptions, PasswordException } from 'pdfjs-dist';
// Bundled locally so no third-party CDN is ever contacted.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Block } from '../types';
import { ExtractionError } from './errors';
import { blocksFromPdfItems, type PdfTextItem } from './pdfLayout';

GlobalWorkerOptions.workerSrc = workerUrl;

export async function blocksFromPdf(
  data: ArrayBuffer,
  onProgress?: (page: number, total: number) => void,
): Promise<{ blocks: Block[]; pageCount: number }> {
  const task = getDocument({
    data: new Uint8Array(data),
    // Hardening: no scripting, no XFA forms, no remote font/CMap fetching.
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Served from this origin (copied from pdfjs-dist at build time).
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (err instanceof PasswordException) throw new ExtractionError('This PDF is password-protected. Remove the password and try again.');
    throw new ExtractionError('This file could not be read as a PDF.');
  }
  try {
    const pages: PdfTextItem[][] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.filter((it) => 'str' in it) as PdfTextItem[]);
      page.cleanup();
      onProgress?.(p, pdf.numPages);
    }
    const blocks = blocksFromPdfItems(pages);
    if (!blocks.length) {
      throw new ExtractionError(
        'No text layer was found in this PDF (it may be a scanned image). Run it through OCR first, then compare.',
      );
    }
    return { blocks, pageCount: pdf.numPages };
  } finally {
    await task.destroy();
  }
}
