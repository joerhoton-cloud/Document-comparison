import type { Block } from '../types';

/** Split plain text into paragraphs on blank lines; single newlines are soft wraps. */
export function blocksFromText(text: string): Block[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const blocks: Block[] = [];
  for (const para of normalized.split(/\n\s*\n/)) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // Keep list-like lines (bullets, numbering) as separate blocks.
    let current: string[] = [];
    const flush = () => {
      if (current.length) blocks.push({ text: current.join(' '), kind: 'p' });
      current = [];
    };
    for (const line of lines) {
      const bullet = /^([-*•·‣▪]|\d+[.)]|[a-z][.)]|\([a-z0-9]+\))\s+/i.test(line);
      if (bullet) {
        flush();
        blocks.push({ text: line, kind: 'li' });
      } else if (/^#{1,6}\s/.test(line)) {
        flush();
        blocks.push({ text: line.replace(/^#{1,6}\s+/, ''), kind: 'h' });
      } else current.push(line);
    }
    flush();
  }
  return blocks;
}

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote,dt,dd,caption';

/**
 * Extract blocks from an HTML string. The markup is parsed into an inert
 * document (scripts never run, nothing is rendered) and only text is read.
 */
export function blocksFromHtml(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template,iframe,object,embed').forEach((n) => n.remove());
  const blocks: Block[] = [];
  const nodes = doc.body.querySelectorAll(BLOCK_SELECTOR);
  nodes.forEach((el) => {
    // Skip containers whose text is already captured by a nested block element.
    if (el.querySelector(BLOCK_SELECTOR)) {
      const own = directText(el);
      if (own) blocks.push({ text: own, kind: kindOf(el) });
      return;
    }
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ text, kind: kindOf(el) });
  });
  if (!blocks.length) return blocksFromText(doc.body.textContent ?? '');
  return blocks;
}

function directText(el: Element): string {
  let s = '';
  el.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
    else if (n instanceof Element && !n.matches(BLOCK_SELECTOR) && !n.querySelector(BLOCK_SELECTOR)) s += n.textContent;
  });
  return s.replace(/\s+/g, ' ').trim();
}

function kindOf(el: Element): Block['kind'] {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'h';
  if (tag === 'li' || tag === 'dt' || tag === 'dd') return 'li';
  if (tag === 'td' || tag === 'th') return 'cell';
  return 'p';
}
