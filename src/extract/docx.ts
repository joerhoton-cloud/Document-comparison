// The browser build of mammoth is self-contained (no Node built-ins).
import mammoth from 'mammoth/mammoth.browser.js';
import type { Block } from '../types';
import { blocksFromHtml } from './text';

/** Convert a .docx file to blocks via mammoth's semantic HTML output. */
export async function blocksFromDocx(data: ArrayBuffer): Promise<Block[]> {
  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      // Images are irrelevant for text comparison; don't inline them as data URIs.
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      ignoreEmptyParagraphs: true,
    },
  );
  return blocksFromHtml(result.value);
}
