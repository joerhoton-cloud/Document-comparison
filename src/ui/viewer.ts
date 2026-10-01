import type { Change, ChangeType, CompareResult, ExtractedDoc, Row, Segment } from '../types';
import { append, clear, formatBytes, h, icon } from './dom';

/** Unchanged rows kept visible around each change when "changes only" is on. */
const CONTEXT_ROWS = 1;

const TYPE_LABEL: Record<ChangeType, string> = {
  replaced: 'Changed',
  inserted: 'Added',
  deleted: 'Removed',
};

export interface ViewerCallbacks {
  onNewComparison(): void;
  onSwap(): void;
  onExportHtml(): void;
  onExportCsv(): void;
  onPrint(): void;
  /** Copies the differences as tab-separated text; resolves false if the clipboard refused. */
  onCopy(): Promise<boolean>;
  /** False where downloads and printing are unavailable (e.g. sandboxed embeds). */
  canDownload: boolean;
  optionsPanel(): HTMLElement;
}

export interface ReviewMarkView {
  status: 'reviewed' | 'flagged';
  note: string | null;
  by: string;
}

/** Shared review state for a saved comparison (see src/app/review.ts). */
export interface ReviewController {
  /** Marks keyed by change id. */
  marks: Map<number, ReviewMarkView>;
  /** False when only activity is logged (or nothing is saved): marks can't be recorded. */
  canEdit: boolean;
  /** Short status line above the list, e.g. "Saved to Acme · visible to your team". */
  label: string;
  onMark(changeId: number, status: 'reviewed' | 'flagged' | null, note: string | null): Promise<boolean>;
  /** Offered when not saving progress; starts saving review progress for this comparison. */
  onEnableProgress?: () => void;
  enableLabel?: string;
}

/** Side-by-side comparison view with a navigable list of differences. */
export class Viewer {
  readonly root: HTMLElement;
  private result!: CompareResult;
  private filters = new Set<ChangeType>(['replaced', 'inserted', 'deleted']);
  private changesOnly = false;
  private expanded = new Set<number>();
  private currentId: number | null = null;
  private review: ReviewController | null = null;
  private hideReviewed = false;
  private reviewBar = h('div', { class: 'review-bar', hidden: true });
  private progressEl = h('span', { class: 'review-progress', hidden: true });

  private rowsEl = h('div', { class: 'rows', tabindex: '0', 'aria-label': 'Side-by-side comparison' });
  private listEl = h('ol', { class: 'change-list' });
  private summaryEl = h('div', { class: 'summary' });
  private counterEl = h('span', { class: 'counter', 'aria-live': 'polite' });
  private headsEl = h('div', { class: 'col-heads' });
  private settingsEl = h('div', { class: 'settings-pop', hidden: true });
  private changesOnlyInput = h('input', {
    type: 'checkbox',
    onchange: (e: Event) => {
      this.changesOnly = (e.target as HTMLInputElement).checked;
      this.expanded.clear();
      this.renderRows();
      if (this.currentId !== null) this.select(this.currentId, false);
    },
  });

  constructor(private cb: ViewerCallbacks) {
    const settingsBtn = h('button', { class: 'btn ghost', 'aria-expanded': 'false', title: 'Comparison settings' }, icon('sliders'), 'Settings');
    settingsBtn.addEventListener('click', () => {
      const open = this.settingsEl.hidden;
      this.settingsEl.hidden = !open;
      settingsBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        clear(this.settingsEl);
        this.settingsEl.append(this.cb.optionsPanel());
      }
    });

    const exportMenu = h(
      'details',
      { class: 'menu' },
      h('summary', { class: 'btn' }, icon('download'), this.cb.canDownload ? 'Export' : 'Share'),
      h(
        'div',
        { class: 'menu-items' },
        this.cb.canDownload && h('button', { onclick: () => this.cb.onExportHtml() }, 'Comparison report (.html)'),
        this.cb.canDownload && h('button', { onclick: () => this.cb.onExportCsv() }, 'List of differences (.csv)'),
        this.cb.canDownload && h('button', { onclick: () => this.cb.onPrint() }, icon('print'), 'Print / Save as PDF'),
        h(
          'button',
          {
            onclick: async () => {
              const ok = await this.cb.onCopy();
              this.flash(ok ? 'Copied — paste into Excel, Sheets or an email' : 'Copy was blocked by the browser');
            },
          },
          'Copy list of differences',
        ),
      ),
    );
    exportMenu.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.menu-items button')) exportMenu.open = false;
    });

    this.root = h(
      'section',
      { class: 'results' },
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn ghost', onclick: () => this.cb.onNewComparison(), title: 'Start over (clears both documents from memory)' }, icon('back'), 'New'),
        h('button', { class: 'btn ghost icon-btn', onclick: () => this.cb.onSwap(), title: 'Swap original and revised', 'aria-label': 'Swap original and revised' }, icon('swap')),
        this.summaryEl,
        this.progressEl,
        h('div', { class: 'spacer' }),
        h('label', { class: 'toggle' }, this.changesOnlyInput, h('span', null, 'Changes only')),
        h(
          'div',
          { class: 'nav' },
          h('button', { class: 'btn icon-btn', title: 'Previous difference (↑ or k)', 'aria-label': 'Previous difference', onclick: () => this.step(-1) }, icon('up')),
          this.counterEl,
          h('button', { class: 'btn icon-btn', title: 'Next difference (↓ or j)', 'aria-label': 'Next difference', onclick: () => this.step(1) }, icon('down')),
        ),
        h('div', { class: 'settings-wrap' }, settingsBtn, this.settingsEl),
        exportMenu,
      ),
      h(
        'div',
        { class: 'workspace' },
        h('aside', { class: 'changes-panel', 'aria-label': 'Differences' }, h('h2', null, 'Differences'), this.reviewBar, this.listEl),
        h('div', { class: 'compare' }, this.headsEl, this.rowsEl),
      ),
    );
    this.root.append(this.toastEl);

    this.rowsEl.addEventListener('click', (e) => {
      const seg = (e.target as HTMLElement).closest<HTMLElement>('[data-change]');
      if (seg) this.select(Number(seg.dataset.change), false);
    });
    document.addEventListener('keydown', this.onKey);
  }

  private toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  private toastTimer = 0;

  private flash(message: string) {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), 2600);
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.root.isConnected || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input,select,textarea,summary')) return;
    if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'n') {
      e.preventDefault();
      this.step(1);
    } else if (e.key === 'k' || e.key === 'ArrowUp' || e.key === 'p') {
      e.preventDefault();
      this.step(-1);
    } else if ((e.key === 'r' || e.key === 'f') && this.review?.canEdit && this.currentId !== null) {
      e.preventDefault();
      const status = e.key === 'r' ? 'reviewed' : 'flagged';
      const id = this.currentId;
      const cur = this.review.marks.get(id);
      void this.mark(id, cur?.status === status ? null : status, cur?.note ?? null).then(() => {
        if (status === 'reviewed' && cur?.status !== 'reviewed') this.step(1);
      });
    }
  };

  show(result: CompareResult, left: ExtractedDoc, right: ExtractedDoc) {
    this.result = result;
    this.expanded.clear();
    this.currentId = null;
    this.renderHeads(left, right);
    this.renderSummary();
    this.renderList();
    this.renderRows();
    this.rowsEl.scrollTop = 0;
    this.updateCounter();
  }

  private visibleChanges(): Change[] {
    return this.result.changes.filter(
      (c) => this.filters.has(c.type) && !(this.hideReviewed && this.review?.marks.get(c.id)?.status === 'reviewed'),
    );
  }

  /** Attach (or detach) shared review state. */
  setReview(review: ReviewController | null) {
    this.review = review;
    this.renderReviewBar();
    this.renderList();
    this.applyMarksToRows();
    this.updateCounter();
  }

  private renderReviewBar() {
    clear(this.reviewBar);
    const r = this.review;
    this.reviewBar.hidden = !r;
    this.progressEl.hidden = !r?.canEdit;
    if (!r) return;
    const total = this.result.changes.length;
    const reviewed = [...r.marks.values()].filter((m) => m.status === 'reviewed').length;
    const flagged = [...r.marks.values()].filter((m) => m.status === 'flagged').length;
    this.progressEl.textContent = `${reviewed}/${total} reviewed${flagged ? ` · ${flagged} flagged` : ''}`;
    this.progressEl.classList.toggle('done', total > 0 && reviewed === total);
    append(this.reviewBar, [
      h('span', { class: `save-state ${r.canEdit ? 'saving' : ''}` }, r.label),
      r.onEnableProgress && h('button', { class: 'btn sm', onclick: () => r.onEnableProgress?.() }, r.enableLabel ?? 'Save review progress'),
      r.canEdit &&
        h(
          'label',
          { class: 'toggle sm' },
          h('input', {
            type: 'checkbox',
            checked: this.hideReviewed,
            onchange: (e: Event) => {
              this.hideReviewed = (e.target as HTMLInputElement).checked;
              this.renderList();
              this.updateCounter();
            },
          }),
          h('span', null, 'Hide reviewed'),
        ),
    ]);
  }

  private applyMarksToRows() {
    this.rowsEl.querySelectorAll<HTMLElement>('[data-change]').forEach((el) => {
      const m = this.review?.marks.get(Number(el.dataset.change));
      el.classList.toggle('is-reviewed', m?.status === 'reviewed');
      el.classList.toggle('is-flagged', m?.status === 'flagged');
    });
  }

  private async mark(id: number, status: 'reviewed' | 'flagged' | null, note: string | null) {
    const r = this.review;
    if (!r?.canEdit) return;
    const ok = await r.onMark(id, status, note);
    if (!ok) return this.flash('Could not save. Check your connection and try again.');
    this.renderReviewBar();
    this.applyMarksToRows();
    const li = this.listEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (li) li.replaceWith(this.listItem(this.result.changes[id]));
    if (this.currentId !== null) this.markListItem(this.currentId, false);
    this.updateCounter();
  }

  private renderHeads(left: ExtractedDoc, right: ExtractedDoc) {
    const head = (label: string, d: ExtractedDoc, cls: string) =>
      h(
        'div',
        { class: `col-head ${cls}` },
        h('span', { class: 'col-label' }, label),
        h('span', { class: 'col-name', title: d.name }, icon('file', 14), d.name),
        h(
          'span',
          { class: 'col-meta' },
          [d.format.toUpperCase(), formatBytes(d.size), d.pageCount ? plural(d.pageCount, 'page') : plural(d.blocks.length, 'paragraph')].join(' · '),
        ),
        d.ocrPages &&
          h(
            'span',
            { class: 'ocr-note', title: 'Text on scanned pages was recognized on your device (OCR). Recognition can misread characters, so double-check flagged differences against the original.' },
            d.format === 'image' ? 'Scanned image: text recognized (OCR)' : `${plural(d.ocrPages, 'scanned page')}: text recognized (OCR)`,
          ),
      );
    clear(this.headsEl);
    this.headsEl.append(head('Original', left, 'left'), head('Revised', right, 'right'));
  }

  private renderSummary() {
    const s = this.result.stats;
    clear(this.summaryEl);
    const chip = (type: ChangeType, n: number) =>
      h(
        'button',
        {
          class: `chip ${type}${this.filters.has(type) ? '' : ' off'}`,
          'aria-pressed': String(this.filters.has(type)),
          title: `Show/hide ${TYPE_LABEL[type].toLowerCase()} text in the list`,
          onclick: () => {
            if (this.filters.has(type)) this.filters.delete(type);
            else this.filters.add(type);
            this.renderSummary();
            this.renderList();
            this.updateCounter();
          },
        },
        h('span', { class: 'dot' }),
        `${n} ${TYPE_LABEL[type].toLowerCase()}`,
      );
    this.summaryEl.append(
      h(
        'span',
        { class: 'total' },
        s.total === 0 ? 'No differences' : `${s.total} difference${s.total === 1 ? '' : 's'}`,
      ),
      chip('replaced', s.replaced),
      chip('inserted', s.inserted),
      chip('deleted', s.deleted),
      h('span', { class: 'similarity', title: 'Share of words unchanged' }, `${(s.similarity * 100).toFixed(1)}% match`),
    );
  }

  private renderList() {
    clear(this.listEl);
    const items = this.visibleChanges();
    if (!items.length) {
      this.listEl.append(
        h('li', { class: 'empty' }, this.result.changes.length ? 'All difference types are hidden.' : 'The documents contain the same text.'),
      );
      return;
    }
    for (const c of items) this.listEl.append(this.listItem(c));
    if (this.currentId !== null) this.markListItem(this.currentId, false);
  }

  private listItem(c: Change): HTMLElement {
    const page = c.leftPage || c.rightPage ? `p. ${c.leftPage ?? '–'} ↔ ${c.rightPage ?? '–'}` : `¶ ${c.row + 1}`;
    const m = this.review?.marks.get(c.id);
    return h(
      'li',
      { class: `change-item ${c.type}${m ? ` mark-${m.status}` : ''}`, 'data-id': c.id },
      h(
        'button',
        { class: 'ci-main', onclick: () => this.select(c.id) },
        h(
          'span',
          { class: 'ci-head' },
          h('span', { class: `badge ${c.type}` }, TYPE_LABEL[c.type]),
          m && h('span', { class: `mark ${m.status}`, title: `${m.status === 'reviewed' ? 'Reviewed' : 'Flagged'} by ${m.by}` }, m.status === 'reviewed' ? '✓ Reviewed' : '⚑ Flagged'),
          h('span', { class: 'ci-where' }, page),
        ),
        c.context && h('span', { class: 'ci-context' }, c.context),
        h(
          'span',
          { class: 'ci-body' },
          c.leftText.trim() && h('del', null, snippet(c.leftText)),
          c.leftText.trim() && c.rightText.trim() && h('span', { class: 'arrow' }, ' → '),
          c.rightText.trim() && h('ins', null, snippet(c.rightText)),
        ),
        m?.note && h('span', { class: 'ci-note' }, `“${m.note}” — ${m.by}`),
      ),
    );
  }

  /** Review actions shown under the current change. */
  private itemActions(c: Change): HTMLElement {
    const r = this.review!;
    const m = r.marks.get(c.id);
    const note = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'Add a note for your team', 'aria-label': 'Note' });
    note.value = m?.note ?? '';
    const noteBox = h(
      'div',
      { class: 'ci-note-edit', hidden: !m?.note },
      note,
      h('button', { class: 'btn sm primary', onclick: () => this.mark(c.id, m?.status ?? 'reviewed', note.value.trim() || null) }, 'Save note'),
    );
    return h(
      'div',
      { class: 'ci-actions' },
      h(
        'div',
        { class: 'ci-buttons' },
        h(
          'button',
          { class: `btn sm${m?.status === 'reviewed' ? ' on-reviewed' : ''}`, title: 'Mark reviewed (r)', 'aria-pressed': String(m?.status === 'reviewed'), onclick: () => this.mark(c.id, m?.status === 'reviewed' ? null : 'reviewed', m?.note ?? null) },
          '✓ Reviewed',
        ),
        h(
          'button',
          { class: `btn sm${m?.status === 'flagged' ? ' on-flagged' : ''}`, title: 'Flag for follow-up (f)', 'aria-pressed': String(m?.status === 'flagged'), onclick: () => this.mark(c.id, m?.status === 'flagged' ? null : 'flagged', m?.note ?? null) },
          '⚑ Flag',
        ),
        h(
          'button',
          {
            class: 'btn sm ghost',
            onclick: () => {
              noteBox.hidden = !noteBox.hidden;
              if (!noteBox.hidden) note.focus();
            },
          },
          m?.note ? 'Edit note' : 'Note',
        ),
      ),
      noteBox,
    );
  }

  private renderRows() {
    clear(this.rowsEl);
    const { rows } = this.result;
    const frag = document.createDocumentFragment();
    let lastLeftPage: number | undefined;
    let lastRightPage: number | undefined;

    const visible = this.changesOnly ? visibleRowMask(rows, CONTEXT_ROWS) : null;
    let i = 0;
    while (i < rows.length) {
      if (visible && !visible[i] && !this.expanded.has(i)) {
        const start = i;
        while (i < rows.length && !visible[i]) i++;
        const count = i - start;
        frag.append(
          h(
            'button',
            {
              class: 'collapsed',
              'data-start': start,
              onclick: () => {
                for (let k = start; k < start + count; k++) this.expanded.add(k);
                this.renderRows();
              },
            },
            `${count} unchanged paragraph${count === 1 ? '' : 's'} — show`,
          ),
        );
        continue;
      }
      const row = rows[i];
      const lp = row.left?.page;
      const rp = row.right?.page;
      frag.append(
        h(
          'div',
          { class: `row ${row.type}`, 'data-row': i },
          cell(row, 'left', lp !== undefined && lp !== lastLeftPage ? lp : undefined),
          cell(row, 'right', rp !== undefined && rp !== lastRightPage ? rp : undefined),
        ),
      );
      if (lp !== undefined) lastLeftPage = lp;
      if (rp !== undefined) lastRightPage = rp;
      i++;
    }
    this.rowsEl.append(frag);
    this.applyMarksToRows();
    if (!rows.length) this.rowsEl.append(h('p', { class: 'empty' }, 'Both documents are empty.'));
  }

  private step(dir: 1 | -1) {
    const list = this.visibleChanges();
    if (!list.length) return;
    let idx = list.findIndex((c) => c.id === this.currentId);
    if (idx === -1) {
      // Start from the change nearest the current scroll position.
      idx = dir === 1 ? -1 : list.length;
    }
    idx = Math.min(list.length - 1, Math.max(0, idx + dir));
    this.select(list[idx].id);
  }

  select(id: number, scroll = true) {
    const change = this.result.changes[id];
    if (!change) return;
    // Expand a collapsed region if the change lives inside it.
    if (this.changesOnly && !this.rowsEl.querySelector(`[data-row="${change.row}"]`)) {
      this.expanded.add(change.row);
      this.renderRows();
    }
    this.rowsEl.querySelectorAll('.active').forEach((el) => el.classList.remove('active'));
    const segs = this.rowsEl.querySelectorAll<HTMLElement>(`[data-change="${id}"]`);
    segs.forEach((el) => el.classList.add('active'));
    const rowEl = this.rowsEl.querySelector<HTMLElement>(`[data-row="${change.row}"]`);
    rowEl?.classList.add('active');
    this.currentId = id;
    if (scroll) (segs[0] ?? rowEl)?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    this.markListItem(id, true);
    this.updateCounter();
  }

  private markListItem(id: number, scroll: boolean) {
    this.listEl.querySelectorAll('.current').forEach((el) => el.classList.remove('current'));
    this.listEl.querySelectorAll('.ci-actions').forEach((el) => el.remove());
    const li = this.listEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    li?.classList.add('current');
    if (li && this.review?.canEdit) li.append(this.itemActions(this.result.changes[id]));
    if (scroll) li?.scrollIntoView({ block: 'nearest' });
  }

  private updateCounter() {
    const list = this.visibleChanges();
    const idx = list.findIndex((c) => c.id === this.currentId);
    this.counterEl.textContent = list.length ? `${idx === -1 ? '–' : idx + 1} / ${list.length}` : '0 / 0';
  }
}

function cell(row: Row, side: 'left' | 'right', pageMarker: number | undefined): HTMLElement {
  const block = side === 'left' ? row.left : row.right;
  const segs = side === 'left' ? row.leftSegs : row.rightSegs;
  if (!block) return h('div', { class: `cell ${side} placeholder`, 'aria-hidden': 'true' });
  return h(
    'div',
    { class: `cell ${side} kind-${block.kind}` },
    pageMarker !== undefined && h('span', { class: 'page-marker' }, `Page ${pageMarker}`),
    h('div', { class: 'text' }, ...segs.map(segEl)),
  );
}

function segEl(s: Segment): Node {
  if (s.op === 'eq') return document.createTextNode(s.text);
  return h(s.op === 'ins' ? 'ins' : 'del', { 'data-change': s.change }, s.text);
}

function visibleRowMask(rows: Row[], context: number): boolean[] {
  const mask = rows.map((r) => r.type !== 'equal');
  const out = [...mask];
  mask.forEach((changed, i) => {
    if (!changed) return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) out[k] = true;
  });
  return out;
}

function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
