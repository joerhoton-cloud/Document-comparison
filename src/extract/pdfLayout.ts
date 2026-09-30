import type { Block } from '../types';

/** Subset of pdf.js' TextItem used for layout analysis. */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
}

/**
 * Rebuild paragraphs from positioned PDF text runs.
 * Runs on the same baseline become lines; lines separated by a larger than
 * usual vertical gap, a font-size change, or a column jump start a new block.
 */
export function blocksFromPdfItems(pages: PdfTextItem[][]): Block[] {
  const blocks: Block[] = [];
  pages.forEach((items, idx) => {
    const page = idx + 1;
    const lines = toLines(items);
    const pageBlocks: Block[] = toParagraphs(lines).map((p) => ({ text: p.text, kind: p.heading ? 'h' : 'p', page }));
    // Re-join a paragraph that continues across a page break.
    const prev = blocks[blocks.length - 1];
    const first = pageBlocks[0];
    if (prev && first && !/[.:;!?)"”]$/.test(prev.text) && /^[a-z(]/.test(first.text)) {
      prev.text = joinLines(prev.text, first.text);
      pageBlocks.shift();
    }
    blocks.push(...pageBlocks);
  });
  return blocks.filter((b) => b.text.length > 0);
}

function toLines(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: (Line & { endX: number }) | undefined;
  for (const it of items) {
    const [a, b, , , x, y] = it.transform;
    const size = Math.hypot(a, b) || it.height || 10;
    if (!it.str) {
      if (it.hasEOL && cur) {
        lines.push(cur);
        cur = undefined;
      }
      continue;
    }
    const sameLine = cur && Math.abs(y - cur.y) < Math.max(size, cur.size) * 0.5 && x >= cur.endX - size;
    if (cur && sameLine) {
      const gap = x - cur.endX;
      const needsSpace = gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? ' ' : '') + it.str;
      cur.endX = x + it.width;
      cur.size = Math.max(cur.size, size);
    } else {
      if (cur) lines.push(cur);
      cur = { text: it.str, x, y, size, endX: x + it.width };
    }
    if (it.hasEOL) {
      lines.push(cur);
      cur = undefined;
    }
  }
  if (cur) lines.push(cur);
  return lines
    .map((l) => ({ text: l.text.replace(/\s+/g, ' ').trim(), x: l.x, y: l.y, size: l.size }))
    .filter((l) => l.text);
}

interface Para {
  text: string;
  heading: boolean;
}

function toParagraphs(lines: Line[]): Para[] {
  if (!lines.length) return [];
  // Typical line step on this page. A low percentile of the gaps is used because
  // documents with many one-line paragraphs have more paragraph gaps than line gaps.
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) gaps.push(g);
  }
  gaps.sort((p, q) => p - q);
  const bodySize = dominantSize(lines);
  const raw = gaps.length ? gaps[Math.floor(gaps.length * 0.2)] : bodySize * 1.2;
  const typical = Math.min(Math.max(raw, bodySize * 0.9), bodySize * 1.8);

  const paras: Para[] = [];
  // Short blocks set noticeably larger than body text are treated as headings.
  const isHeading = (size: number, t: string) => size > bodySize * 1.15 && t.length < 200;
  let text = lines[0].text;
  let size = lines[0].size;
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const gap = prev.y - line.y;
    const breakPara =
      gap <= 0 || // moved up: new column or out-of-order content
      gap > typical * 1.4 ||
      Math.abs(line.size - prev.size) > Math.max(1, prev.size * 0.15) ||
      isListItem(line.text);
    if (breakPara) {
      paras.push({ text, heading: isHeading(size, text) });
      text = line.text;
      size = line.size;
    } else text = joinLines(text, line.text);
  }
  paras.push({ text, heading: isHeading(size, text) });
  return paras;
}

/** The font size covering the most characters on the page (i.e. body text). */
function dominantSize(lines: Line[]): number {
  const chars = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    chars.set(k, (chars.get(k) ?? 0) + l.text.length);
  }
  let best = 10;
  let most = -1;
  for (const [size, n] of chars) if (n > most) [best, most] = [size, n];
  return best;
}

function isListItem(text: string): boolean {
  return /^([•·‣▪◦●○■□–-]|\d{1,3}[.)]|\(?[a-z]\)|\([ivx]+\))\s/i.test(text);
}

/** Join two wrapped lines, removing end-of-line hyphenation. */
function joinLines(a: string, b: string): string {
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}
