import type { ExtractedDoc } from '../types';
import { ExtractionError } from './errors';
import { blocksFromHtml, blocksFromText } from './text';

export { ExtractionError };

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.html,.htm,.csv,.png,.jpg,.jpeg,.webp';

type Format = ExtractedDoc['format'];

/** Identify the format from magic bytes first and the extension second. */
export function detectFormat(name: string, head: Uint8Array): Format | undefined {
  const ascii = String.fromCharCode(...head.slice(0, 8));
  if (ascii.startsWith('%PDF-')) return 'pdf';
  // Photos and scans: PNG, JPEG, WebP.
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image';
  if (ascii.startsWith('RIFF') && head.length >= 12 && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return 'image';
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (head[0] === 0x50 && head[1] === 0x4b) return ext === 'docx' ? 'docx' : undefined; // ZIP container
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['txt', 'md', 'markdown', 'csv', ''].includes(ext)) return 'text';
  return undefined;
}

export async function extractDocument(
  file: File,
  onProgress?: (message: string) => void,
): Promise<ExtractedDoc> {
  if (file.size > MAX_FILE_BYTES) throw new ExtractionError(`${file.name} is larger than the 100 MB limit.`);
  if (file.size === 0) throw new ExtractionError(`${file.name} is empty.`);
  const data = await file.arrayBuffer();
  const format = detectFormat(file.name, new Uint8Array(data, 0, Math.min(12, data.byteLength)));
  const base = { name: file.name, size: file.size };

  switch (format) {
    case 'pdf': {
      // Loaded on demand to keep the initial bundle small.
      const { blocksFromPdf } = await import('./pdf');
      const { blocks, pageCount, ocrPages } = await blocksFromPdf(data, file.name, onProgress);
      return { ...base, format, blocks, pageCount, ...(ocrPages && { ocrPages }) };
    }
    case 'image': {
      const { blocksFromImage } = await import('./pdf');
      return { ...base, format, blocks: await blocksFromImage(file, onProgress), pageCount: 1, ocrPages: 1 };
    }
    case 'docx': {
      onProgress?.(`Reading ${file.name}`);
      const { blocksFromDocx } = await import('./docx');
      try {
        return { ...base, format, blocks: await blocksFromDocx(data) };
      } catch {
        throw new ExtractionError(`${file.name} could not be read as a Word document.`);
      }
    }
    case 'html':
      return { ...base, format, blocks: blocksFromHtml(decode(data)) };
    case 'text':
      return { ...base, format, blocks: blocksFromText(decode(data)) };
    default:
      throw new ExtractionError(
        `${file.name}: unsupported file type. Use PDF, Word (.docx), an image (PNG, JPG), HTML or plain text. Legacy .doc files must be saved as .docx first.`,
      );
  }
}

function decode(data: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(data);
}
