import { describe, expect, it } from 'vitest';
import { blocksFromPdfItems, type PdfTextItem } from '../src/extract/pdfLayout';

/** A text run at (x, y) in font size `size`, roughly 0.5em per character wide. */
const run = (str: string, y: number, x = 72, size = 10, hasEOL = true): PdfTextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size * 0.5,
  height: size,
  hasEOL,
});

describe('blocksFromPdfItems', () => {
  it('joins wrapped lines and splits on paragraph gaps', () => {
    const blocks = blocksFromPdfItems([
      [
        run('First paragraph line one', 700),
        run('continues on line two.', 688),
        run('Second paragraph.', 664),
        run('Third paragraph.', 640),
      ],
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      'First paragraph line one continues on line two.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
    expect(blocks.every((b) => b.page === 1)).toBe(true);
  });

  it('starts a new block when the font size changes (headings)', () => {
    const blocks = blocksFromPdfItems([[run('Heading', 700, 72, 16), run('Body text.', 684)]]);
    expect(blocks.map((b) => [b.text, b.kind])).toEqual([
      ['Heading', 'h'],
      ['Body text.', 'p'],
    ]);
  });

  it('merges runs on the same baseline and removes hyphenation', () => {
    const blocks = blocksFromPdfItems([
      [run('The agree', 700, 72, 10, false), run('ment is bind-', 700, 72 + 45, 10), run('ing on both parties.', 688)],
    ]);
    expect(blocks.map((b) => b.text)).toEqual(['The agreement is binding on both parties.']);
  });

  it('inserts a space between runs separated by a visible gap', () => {
    const blocks = blocksFromPdfItems([[run('Hello', 700, 72, 10, false), run('world', 700, 72 + 25 + 5)]]);
    expect(blocks[0].text).toBe('Hello world');
  });

  it('re-joins a sentence split across a page break', () => {
    const blocks = blocksFromPdfItems([[run('This sentence continues', 100)], [run('on the next page.', 700)]]);
    expect(blocks).toEqual([{ text: 'This sentence continues on the next page.', kind: 'p', page: 1 }]);
  });

  it('treats list markers as new blocks', () => {
    const blocks = blocksFromPdfItems([[run('Items:', 700), run('1. First', 688), run('2. Second', 676)]]);
    expect(blocks.map((b) => b.text)).toEqual(['Items:', '1. First', '2. Second']);
  });
});
