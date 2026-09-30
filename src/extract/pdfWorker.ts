// Bundled locally so no third-party CDN is ever contacted.
import url from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export const workerSrc: string = url;
/** Base URL for PDF.js character maps and standard fonts (copied to public/pdfjs at build time). */
export const pdfAssetBase: string | undefined = '/pdfjs/';
