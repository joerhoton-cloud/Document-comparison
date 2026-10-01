// Single-file build: the worker source is embedded in the page and started from a blob: URL.
import source from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw';

export const workerSrc: string = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
/** Character maps and fonts aren't embedded in the single-file build. */
export const pdfAssetBase: string | undefined = undefined;
/** OCR assets (~10 MB) aren't embedded in the single-file build. */
export const ocrBase: string | undefined = undefined;
