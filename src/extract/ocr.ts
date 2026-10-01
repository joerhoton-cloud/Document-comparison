import type { Worker } from 'tesseract.js';
import { ExtractionError } from './errors';
import type { PdfTextItem } from './pdfLayout';
import { ocrBase } from './pdfWorker';

/**
 * In-browser OCR with Tesseract (WebAssembly). The engine, its worker and the
 * English model are served from this app's own origin, so scanned pages are
 * recognised on the user's device and never sent anywhere.
 */
export interface Ocr {
  /** Recognise one rendered page; returns text lines in page coordinates (points, origin bottom-left). */
  recognize(canvas: HTMLCanvasElement | OffscreenCanvas, pageHeightPts: number, scale: number): Promise<PdfTextItem[]>;
  terminate(): Promise<void>;
}

export const OCR_AVAILABLE = !!ocrBase;

export async function createOcr(onProgress?: (fraction: number) => void): Promise<Ocr> {
  if (!ocrBase) throw new ExtractionError('This copy of DocCompare cannot read scanned documents. Use the full web app, or run the file through OCR first.');
  const { createWorker, OEM } = await import('tesseract.js');
  let worker: Worker;
  try {
    worker = await createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: `${ocrBase}worker.min.js`,
      corePath: `${ocrBase}core`,
      langPath: `${ocrBase}lang`,
      gzip: true,
      workerBlobURL: false,
      // The language model (~3 MB) is cached in this browser after the first scan.
      cacheMethod: 'write',
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.(m.progress);
      },
    });
  } catch {
    throw new ExtractionError('The text-recognition engine could not start in this browser. Try an up-to-date Chrome, Edge, Safari or Firefox.');
  }

  return {
    async recognize(canvas, pageHeightPts, scale) {
      const { data } = await worker.recognize(canvas as HTMLCanvasElement, {}, { blocks: true, text: false });
      const items: PdfTextItem[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            const text = line.text.replace(/\s+/g, ' ').trim();
            if (!text || line.confidence < 30) continue; // speckles and noise
            const { x0, x1, y1 } = line.bbox;
            const rowHeight = line.rowAttributes?.rowHeight || line.bbox.y1 - line.bbox.y0;
            const size = (rowHeight / scale) * 0.75; // row height ≈ 1.33 × font size
            items.push({
              str: text,
              // PDF space: origin bottom-left, baseline at the line's bottom edge.
              transform: [size, 0, 0, size, x0 / scale, pageHeightPts - y1 / scale],
              width: (x1 - x0) / scale,
              height: size,
              hasEOL: true,
            });
          }
        }
      }
      return items;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}

/** Pages with fewer meaningful characters than this are treated as scans and OCR'd. */
export const MIN_TEXT_CHARS = 25;

export function hasTextLayer(items: PdfTextItem[]): boolean {
  let n = 0;
  for (const it of items) n += it.str.replace(/\s/g, '').length;
  return n >= MIN_TEXT_CHARS;
}
