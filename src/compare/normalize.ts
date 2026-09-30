import type { CompareOptions } from '../types';

const PUNCT = /[\p{P}\p{S}]/gu;
// Numbers keep their separators ("48,000", "1.5", "7:00") so a changed amount is one change.
const TOKEN = /\s+|\p{N}+(?:[.,:/]\p{N}+)*|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}\p{M}]/gu;
const WS = /^\s+$/u;
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;

/** Canonical form of a string under the given options, used for equality tests. */
export function normalize(text: string, opts: CompareOptions): string {
  let t = text.normalize('NFKC');
  // Treat typographic quotes/dashes as their plain equivalents: they commonly
  // differ between Word and PDF exports of the same document.
  t = t.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―−]/g, '-');
  if (opts.ignoreCase) t = t.toLocaleLowerCase();
  if (opts.ignorePunctuation) t = t.replace(PUNCT, ' ');
  if (opts.ignoreWhitespace || opts.ignorePunctuation) t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/** Split text into word, whitespace and punctuation tokens (concatenation reproduces the input). */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export const isWhitespace = (tok: string) => WS.test(tok);
export const isPunctuation = (tok: string) => PUNCT_ONLY.test(tok);

export function wordCount(text: string): number {
  let n = 0;
  for (const t of tokenize(text)) if (!isWhitespace(t) && !isPunctuation(t)) n++;
  return n;
}

/** Dice similarity between the word multisets of two strings (0..1). */
export function similarity(a: string, b: string): number {
  const wa = tokenize(a.toLocaleLowerCase()).filter((t) => !isWhitespace(t) && !isPunctuation(t));
  const wb = tokenize(b.toLocaleLowerCase()).filter((t) => !isWhitespace(t) && !isPunctuation(t));
  if (wa.length === 0 && wb.length === 0) return a.trim() === b.trim() ? 1 : 0;
  if (wa.length === 0 || wb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const c = counts.get(w);
    if (c) {
      common++;
      counts.set(w, c - 1);
    }
  }
  return (2 * common) / (wa.length + wb.length);
}
