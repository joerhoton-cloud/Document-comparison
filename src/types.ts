/** A logical unit of text extracted from a document (paragraph, heading, list item, table cell). */
export interface Block {
  text: string;
  kind: 'p' | 'h' | 'li' | 'cell';
  /** 1-based page number, when the source format has pages (PDF). */
  page?: number;
}

export interface ExtractedDoc {
  name: string;
  format: 'pdf' | 'docx' | 'text' | 'html' | 'image';
  size: number;
  blocks: Block[];
  pageCount?: number;
  /** Pages whose text came from OCR (scans); recognised text may contain errors. */
  ocrPages?: number;
}

export interface CompareOptions {
  ignoreCase: boolean;
  ignorePunctuation: boolean;
  ignoreWhitespace: boolean;
  granularity: 'word' | 'char';
}

export const DEFAULT_OPTIONS: CompareOptions = {
  ignoreCase: false,
  ignorePunctuation: false,
  ignoreWhitespace: true,
  granularity: 'word',
};

export type SegmentOp = 'eq' | 'ins' | 'del';

export interface Segment {
  text: string;
  op: SegmentOp;
  /** Id of the change (hunk) this segment belongs to; undefined for unchanged text. */
  change?: number;
}

export type RowType = 'equal' | 'inserted' | 'deleted' | 'modified';

/** One aligned row of the side-by-side view. */
export interface Row {
  type: RowType;
  left?: Block;
  right?: Block;
  leftSegs: Segment[];
  rightSegs: Segment[];
}

export type ChangeType = 'inserted' | 'deleted' | 'replaced';

export interface Change {
  id: number;
  type: ChangeType;
  row: number;
  leftText: string;
  rightText: string;
  leftPage?: number;
  rightPage?: number;
  /** Surrounding unchanged text, for context in the change list and report. */
  context: string;
}

export interface CompareStats {
  inserted: number;
  deleted: number;
  replaced: number;
  total: number;
  /** 0..1 share of word tokens that are unchanged. */
  similarity: number;
  leftBlocks: number;
  rightBlocks: number;
}

export interface CompareResult {
  rows: Row[];
  changes: Change[];
  stats: CompareStats;
  options: CompareOptions;
}
