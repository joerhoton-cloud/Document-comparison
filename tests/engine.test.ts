import { describe, expect, it } from 'vitest';
import { compareDocuments, inlineDiff } from '../src/compare/engine';
import { DEFAULT_OPTIONS, type Block, type CompareOptions } from '../src/types';

const blocks = (...texts: string[]): Block[] => texts.map((text) => ({ text, kind: 'p' }));
const opts = (o: Partial<CompareOptions> = {}): CompareOptions => ({ ...DEFAULT_OPTIONS, ...o });
const render = (segs: { text: string; op: string }[]) =>
  segs.map((s) => (s.op === 'eq' ? s.text : s.op === 'ins' ? `[+${s.text}]` : `[-${s.text}]`)).join('');

describe('compareDocuments', () => {
  it('reports identical documents as fully equal', () => {
    const r = compareDocuments(blocks('A', 'B'), blocks('A', 'B'), opts());
    expect(r.changes).toHaveLength(0);
    expect(r.rows.every((row) => row.type === 'equal')).toBe(true);
    expect(r.stats.similarity).toBe(1);
  });

  it('detects inserted and deleted paragraphs', () => {
    const r = compareDocuments(
      blocks('Intro', 'Removed clause about widgets.', 'End'),
      blocks('Intro', 'End', 'Brand new appendix.'),
      opts(),
    );
    expect(r.rows.map((x) => x.type)).toEqual(['equal', 'deleted', 'equal', 'inserted']);
    expect(r.changes.map((c) => c.type)).toEqual(['deleted', 'inserted']);
  });

  it('pairs similar paragraphs as modified and diffs words inside them', () => {
    const r = compareDocuments(
      blocks('The fee is 100 dollars per month, payable in advance.'),
      blocks('The fee is 150 dollars per month, payable in arrears.'),
      opts(),
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.type).toBe('modified');
    expect(render(row.leftSegs)).toBe('The fee is [-100 ]dollars per month, payable in [-advance].');
    expect(render(row.rightSegs)).toBe('The fee is [+150 ]dollars per month, payable in [+arrears].');
    expect(r.changes.map((c) => [c.type, c.leftText.trim(), c.rightText.trim()])).toEqual([
      ['replaced', '100', '150'],
      ['replaced', 'advance', 'arrears'],
    ]);
    // Every change segment is tagged with an id that exists in the change list.
    for (const s of [...row.leftSegs, ...row.rightSegs]) {
      if (s.op !== 'eq') expect(r.changes[s.change!]).toBeDefined();
      else expect(s.change).toBeUndefined();
    }
  });

  it('gives pure deletions inside a paragraph their own change', () => {
    const r = compareDocuments(blocks('one two three four five'), blocks('one two four five'), opts());
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: 'deleted', leftText: 'three ', rightText: '' });
    expect(r.changes[0].context).toBe('one two');
  });

  it('keeps unrelated paragraphs as separate delete + insert', () => {
    const r = compareDocuments(
      blocks('Totally different content here.'),
      blocks('Nothing in common whatsoever!'),
      opts(),
    );
    expect(r.rows.map((x) => x.type)).toEqual(['deleted', 'inserted']);
  });

  it('aligns the right pairs when several paragraphs change', () => {
    const r = compareDocuments(
      blocks('Alpha clause one applies here.', 'Beta clause two applies there.', 'Same'),
      blocks('New inserted text.', 'Alpha clause 1 applies here.', 'Beta clause 2 applies there.', 'Same'),
      opts(),
    );
    expect(r.rows.map((x) => x.type)).toEqual(['inserted', 'modified', 'modified', 'equal']);
  });

  it('pairs a run of several edited paragraphs with an added one', () => {
    const r = compareDocuments(
      blocks(
        'Provider shall deliver daily media monitoring reports covering print and online sources.',
        'Reports will be delivered by email no later than 8:00 a.m. Eastern Time each business day.',
      ),
      blocks(
        'Provider shall deliver daily media monitoring reports covering print, podcast and online sources.',
        'Reports will be delivered through the online platform no later than 7:00 a.m. Eastern Time each business day.',
        'Provider shall also deliver a monthly executive summary.',
      ),
      opts(),
    );
    expect(r.rows.map((x) => x.type)).toEqual(['modified', 'modified', 'inserted']);
  });

  it('honours ignoreCase', () => {
    expect(compareDocuments(blocks('Hello World'), blocks('hello world'), opts()).changes).toHaveLength(1);
    expect(compareDocuments(blocks('Hello World'), blocks('hello world'), opts({ ignoreCase: true })).changes).toHaveLength(0);
  });

  it('honours ignorePunctuation', () => {
    const a = blocks('Yes, we agree.');
    const b = blocks('Yes we agree!');
    expect(compareDocuments(a, b, opts()).changes.length).toBeGreaterThan(0);
    expect(compareDocuments(a, b, opts({ ignorePunctuation: true })).changes).toHaveLength(0);
  });

  it('treats typographic and straight quotes as equal', () => {
    expect(compareDocuments(blocks('the “party’s” rights'), blocks('the "party\'s" rights'), opts()).changes).toHaveLength(0);
  });

  it('merges changes separated only by punctuation into one', () => {
    const r = compareDocuments(blocks('a term of twelve (12) months'), blocks('a term of twenty-four (24) months'), opts());
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ type: 'replaced', leftText: 'twelve (12', rightText: 'twenty-four (24' });
    expect(r.changes[0].context).toBe('a term of');
  });

  it('builds context from the original text, including earlier edits', () => {
    const r = compareDocuments(blocks('fee of $48,000, payable quarterly'), blocks('fee of $52,500, payable annually'), opts());
    expect(r.changes[1].context).toBe('fee of $48,000, payable');
  });

  it('treats formatted numbers as single tokens', () => {
    const r = compareDocuments(blocks('Fee: $48,000 due at 8:00.'), blocks('Fee: $52,500 due at 7:30.'), opts());
    expect(r.changes.map((c) => [c.leftText.trim(), c.rightText.trim()])).toEqual([
      ['48,000', '52,500'],
      ['8:00', '7:30'],
    ]);
  });

  it('ignores whitespace differences by default', () => {
    expect(compareDocuments(blocks('a   b\tc'), blocks('a b c'), opts()).changes).toHaveLength(0);
  });
});

describe('inlineDiff', () => {
  it('supports character granularity', () => {
    const { leftSegs, rightSegs, hunks } = inlineDiff('colour', 'color', opts({ granularity: 'char' }));
    expect(render(leftSegs)).toBe('colo[-u]r');
    expect(render(rightSegs)).toBe('color');
    expect(hunks).toHaveLength(1);
  });

  it('reconstructs the original text exactly on both sides', () => {
    const a = 'Section 4.2 — The Licensee shall pay   the fees (see Schedule B).';
    const b = 'Section 4.3 – Licensee must pay the fees, see Schedule C.';
    for (const granularity of ['word', 'char'] as const) {
      const { leftSegs, rightSegs } = inlineDiff(a, b, opts({ granularity }));
      expect(leftSegs.map((s) => s.text).join('')).toBe(a);
      expect(rightSegs.map((s) => s.text).join('')).toBe(b);
    }
  });
});
