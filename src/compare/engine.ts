import { diffArrays } from 'diff';
import type {
  Block,
  Change,
  CompareOptions,
  CompareResult,
  Row,
  Segment,
  SegmentOp,
} from '../types';
import { isPunctuation, isWhitespace, normalize, similarity, tokenize, wordCount } from './normalize';

/** Minimum similarity for a deleted and an inserted paragraph to be shown as one modified paragraph. */
const PAIR_THRESHOLD = 0.3;
/** Above this many candidate pairs the optimal alignment is replaced by a linear greedy pass. */
const MAX_DP_CELLS = 250_000;

interface Unit {
  text: string;
  key: string;
}

/** Row while being built: modified rows temporarily carry their local hunks. */
type ModifiedRow = Row & { hunks?: InlineHunk[] };

interface Op {
  op: SegmentOp;
  left: string;
  right: string;
}

/**
 * Compare two documents block-by-block, then word-by-word (or char-by-char)
 * inside blocks that were modified.
 */
export function compareDocuments(
  leftBlocks: Block[],
  rightBlocks: Block[],
  options: CompareOptions,
): CompareResult {
  const leftKeys = leftBlocks.map((b) => normalize(b.text, options));
  const rightKeys = rightBlocks.map((b) => normalize(b.text, options));
  const parts = diffArrays(leftKeys, rightKeys);

  const rows: ModifiedRow[] = [];
  let li = 0;
  let ri = 0;
  let pendingDel: Block[] = [];
  let pendingIns: Block[] = [];

  const flush = () => {
    if (pendingDel.length || pendingIns.length) {
      rows.push(...alignChangedBlocks(pendingDel, pendingIns, options));
      pendingDel = [];
      pendingIns = [];
    }
  };

  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      pendingDel.push(...leftBlocks.slice(li, li + n));
      li += n;
    } else if (part.added) {
      pendingIns.push(...rightBlocks.slice(ri, ri + n));
      ri += n;
    } else {
      flush();
      for (let k = 0; k < n; k++) {
        const left = leftBlocks[li + k];
        const right = rightBlocks[ri + k];
        rows.push({
          type: 'equal',
          left,
          right,
          leftSegs: [{ text: left.text, op: 'eq' }],
          rightSegs: [{ text: right.text, op: 'eq' }],
        });
      }
      li += n;
      ri += n;
    }
  }
  flush();

  const changes = assignChanges(rows);
  return { rows, changes, stats: computeStats(rows, changes, leftBlocks, rightBlocks), options };
}

/** Pair deleted/inserted blocks that are similar enough into "modified" rows, preserving order. */
function alignChangedBlocks(dels: Block[], ins: Block[], options: CompareOptions): ModifiedRow[] {
  const pairs = dels.length * ins.length <= MAX_DP_CELLS ? optimalPairs(dels, ins) : greedyPairs(dels, ins);
  const rows: ModifiedRow[] = [];
  let d = 0;
  let a = 0;
  const pushDeleted = (b: Block) =>
    rows.push({ type: 'deleted', left: b, leftSegs: [{ text: b.text, op: 'del' }], rightSegs: [] });
  const pushInserted = (b: Block) =>
    rows.push({ type: 'inserted', right: b, leftSegs: [], rightSegs: [{ text: b.text, op: 'ins' }] });

  for (const [pd, pa] of pairs) {
    while (d < pd) pushDeleted(dels[d++]);
    while (a < pa) pushInserted(ins[a++]);
    const left = dels[d++];
    const right = ins[a++];
    const { leftSegs, rightSegs, hunks } = inlineDiff(left.text, right.text, options);
    rows.push({ type: 'modified', left, right, leftSegs, rightSegs, hunks });
  }
  while (d < dels.length) pushDeleted(dels[d++]);
  while (a < ins.length) pushInserted(ins[a++]);
  return rows;
}

/** Order-preserving alignment maximising total similarity (Needleman–Wunsch with zero gap cost). */
function optimalPairs(dels: Block[], ins: Block[]): [number, number][] {
  const n = dels.length;
  const m = ins.length;
  if (!n || !m) return [];
  const sim = new Float64Array(n * m);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const s = similarity(dels[i].text, ins[j].text);
      sim[i * m + j] = s >= PAIR_THRESHOLD ? s : 0;
    }
  const score = new Float64Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const s = sim[(i - 1) * m + (j - 1)];
      score[i * W + j] = Math.max(
        score[(i - 1) * W + j],
        score[i * W + j - 1],
        s > 0 ? score[(i - 1) * W + j - 1] + s : 0,
      );
    }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = sim[(i - 1) * m + (j - 1)];
    if (s > 0 && score[i * W + j] === score[(i - 1) * W + j - 1] + s) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (score[i * W + j] === score[(i - 1) * W + j]) i--;
    else j--;
  }
  return pairs.reverse();
}

function greedyPairs(dels: Block[], ins: Block[]): [number, number][] {
  const pairs: [number, number][] = [];
  let j = 0;
  for (let i = 0; i < dels.length && j < ins.length; i++) {
    // Look a few blocks ahead for a match so a single inserted paragraph doesn't break pairing.
    for (let k = j; k < Math.min(ins.length, j + 5); k++) {
      if (similarity(dels[i].text, ins[k].text) >= PAIR_THRESHOLD) {
        pairs.push([i, k]);
        j = k + 1;
        break;
      }
    }
  }
  return pairs;
}

export interface InlineHunk {
  left: string;
  right: string;
  context: string;
}

/**
 * Word- or character-level diff of two strings. Each contiguous run of
 * non-equal operations forms a hunk; segments carry the hunk's local index.
 */
export function inlineDiff(
  left: string,
  right: string,
  options: CompareOptions,
): { leftSegs: Segment[]; rightSegs: Segment[]; hunks: InlineHunk[] } {
  const ops = options.granularity === 'char' ? charOps(left, right, options) : wordOps(left, right, options);
  const leftSegs: Segment[] = [];
  const rightSegs: Segment[] = [];
  const hunks: InlineHunk[] = [];
  let tail = ''; // original text preceding the current position, for context
  let current: InlineHunk | undefined;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === 'eq') {
      // Equal text made only of punctuation/spacing between two changes doesn't split them:
      // "twelve (12)" → "twenty-four (24)" is one change, not two.
      const bridges = current && i + 1 < ops.length && ops[i + 1].op !== 'eq' && !hasWord(o.left) && !hasWord(o.right);
      if (bridges) {
        current!.left += o.left;
        current!.right += o.right;
      } else current = undefined;
      tail = (tail + o.left).slice(-80);
      pushSeg(leftSegs, o.left, 'eq');
      pushSeg(rightSegs, o.right, 'eq');
      continue;
    }
    if (!current) {
      current = { left: '', right: '', context: contextFrom(tail) };
      hunks.push(current);
    }
    const id = hunks.length - 1;
    current.left += o.left;
    current.right += o.right;
    tail = (tail + o.left).slice(-80);
    if (o.left) pushSeg(leftSegs, o.left, 'del', id);
    if (o.right) pushSeg(rightSegs, o.right, 'ins', id);
  }
  return { leftSegs, rightSegs, hunks };
}

const hasWord = (s: string) => /[\p{L}\p{N}]/u.test(s);

function contextFrom(tail: string): string {
  const words = tail.trim().split(/\s+/).filter(Boolean);
  return words.length > 6 ? '… ' + words.slice(-6).join(' ') : words.join(' ');
}

function pushSeg(segs: Segment[], text: string, op: SegmentOp, change?: number) {
  if (!text) return;
  const last = segs[segs.length - 1];
  if (last && last.op === op && last.change === change) last.text += text;
  else segs.push(change === undefined ? { text, op } : { text, op, change });
}

/** Group tokens into units: each significant token carries its trailing insignificant tokens. */
function toUnits(text: string, options: CompareOptions): { prefix: string; units: Unit[] } {
  let prefix = '';
  const units: Unit[] = [];
  for (const tok of tokenize(text)) {
    const insignificant = isWhitespace(tok) || (options.ignorePunctuation && isPunctuation(tok));
    if (insignificant) {
      if (units.length) units[units.length - 1].text += tok;
      else prefix += tok;
    } else {
      units.push({ text: tok, key: normalize(tok, options) });
    }
  }
  return { prefix, units };
}

function wordOps(left: string, right: string, options: CompareOptions): Op[] {
  const L = toUnits(left, options);
  const R = toUnits(right, options);
  const ops: Op[] = [];
  if (L.prefix || R.prefix) ops.push({ op: 'eq', left: L.prefix, right: R.prefix });
  const parts = diffArrays(
    L.units.map((u) => u.key),
    R.units.map((u) => u.key),
  );
  let li = 0;
  let ri = 0;
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      ops.push({ op: 'del', left: join(L.units, li, n), right: '' });
      li += n;
    } else if (part.added) {
      ops.push({ op: 'ins', left: '', right: join(R.units, ri, n) });
      ri += n;
    } else {
      // Emit equal units one by one so trailing-whitespace differences stay "equal".
      for (let k = 0; k < n; k++) ops.push({ op: 'eq', left: L.units[li + k].text, right: R.units[ri + k].text });
      li += n;
      ri += n;
    }
  }
  return ops;
}

function join(units: Unit[], start: number, n: number): string {
  let s = '';
  for (let k = start; k < start + n; k++) s += units[k].text;
  return s;
}

function charOps(left: string, right: string, options: CompareOptions): Op[] {
  const a = Array.from(left);
  const b = Array.from(right);
  const canon = (c: string) => {
    if (/\s/u.test(c)) return options.ignoreWhitespace ? ' ' : c;
    if (options.ignorePunctuation && isPunctuation(c)) return '';
    return normalize(c, { ...options, ignoreWhitespace: false, ignorePunctuation: false });
  };
  const parts = diffArrays(a, b, { comparator: (x: string, y: string) => canon(x) === canon(y) });
  const ops: Op[] = [];
  let li = 0;
  let ri = 0;
  for (const part of parts) {
    const n = part.count ?? part.value.length;
    if (part.removed) {
      ops.push({ op: 'del', left: a.slice(li, li + n).join(''), right: '' });
      li += n;
    } else if (part.added) {
      ops.push({ op: 'ins', left: '', right: b.slice(ri, ri + n).join('') });
      ri += n;
    } else {
      ops.push({ op: 'eq', left: a.slice(li, li + n).join(''), right: b.slice(ri, ri + n).join('') });
      li += n;
      ri += n;
    }
  }
  return ops;
}

/** Give every change a global id and tag its segments with it. */
function assignChanges(rows: ModifiedRow[]): Change[] {
  const changes: Change[] = [];
  rows.forEach((row, rowIdx) => {
    if (row.type === 'equal') return;
    const base = {
      row: rowIdx,
      leftPage: row.left?.page,
      rightPage: row.right?.page,
    };
    if (row.type === 'deleted' || row.type === 'inserted') {
      const id = changes.length;
      (row.type === 'deleted' ? row.leftSegs : row.rightSegs).forEach((s) => (s.change = id));
      changes.push({
        id,
        type: row.type,
        leftText: row.left?.text ?? '',
        rightText: row.right?.text ?? '',
        context: '',
        ...base,
      });
      return;
    }
    const offset = changes.length;
    for (const s of [...row.leftSegs, ...row.rightSegs]) if (s.change !== undefined) s.change += offset;
    (row.hunks ?? []).forEach((h, k) => {
      const hasLeft = h.left.trim() !== '';
      const hasRight = h.right.trim() !== '';
      changes.push({
        id: offset + k,
        type: hasLeft && hasRight ? 'replaced' : hasLeft ? 'deleted' : 'inserted',
        leftText: h.left,
        rightText: h.right,
        context: h.context,
        ...base,
      });
    });
    delete row.hunks;
  });
  return changes;
}

function computeStats(rows: Row[], changes: Change[], leftBlocks: Block[], rightBlocks: Block[]) {
  let eqWords = 0;
  let leftWords = 0;
  let rightWords = 0;
  for (const r of rows) {
    for (const s of r.leftSegs) {
      const w = wordCount(s.text);
      leftWords += w;
      if (s.op === 'eq') eqWords += w;
    }
    for (const s of r.rightSegs) {
      const w = wordCount(s.text);
      rightWords += w;
      if (s.op === 'eq') eqWords += w;
    }
  }
  const count = (t: Change['type']) => changes.filter((c) => c.type === t).length;
  return {
    inserted: count('inserted'),
    deleted: count('deleted'),
    replaced: count('replaced'),
    total: changes.length,
    similarity: leftWords + rightWords === 0 ? 1 : eqWords / (leftWords + rightWords),
    leftBlocks: leftBlocks.length,
    rightBlocks: rightBlocks.length,
  };
}
