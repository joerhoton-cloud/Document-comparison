import './styles.css';
import { compareDocuments } from './compare/engine';
import { ACCEPT, extractDocument, ExtractionError } from './extract';
import { buildCsv, buildHtmlReport, download, sha256 } from './report';
import { DEFAULT_OPTIONS, type CompareOptions, type CompareResult, type ExtractedDoc } from './types';
import { clear, formatBytes, h, icon } from './ui/dom';
import { optionsPanel } from './ui/options';
import { Viewer } from './ui/viewer';

type Side = 0 | 1;

interface Slot {
  file: File | null;
  doc: Promise<ExtractedDoc> | null;
}

const OPTIONS_KEY = 'doccompare.options';

const state = {
  slots: [
    { file: null, doc: null },
    { file: null, doc: null },
  ] as [Slot, Slot],
  options: loadOptions(),
  result: null as CompareResult | null,
  docs: null as [ExtractedDoc, ExtractedDoc] | null,
  busy: false,
};

const app = document.getElementById('app')!;
const main = h('main', { class: 'main' });
const statusEl = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
let viewer: Viewer | null = null;

app.append(
  h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '', width: 22, height: 22 }), h('span', null, 'DocCompare')),
    h(
      'div',
      { class: 'secure-badge', title: 'Files are read and compared inside this browser tab. Nothing is uploaded, stored or logged.' },
      icon('lock', 14),
      'Private: files never leave your device',
    ),
  ),
  main,
);

renderSetup();

// ---------------------------------------------------------------- setup screen

function renderSetup() {
  viewer?.destroy();
  viewer = null;
  clear(main);
  main.className = 'main setup';
  const compareBtn = h(
    'button',
    { class: 'btn primary lg', disabled: !(state.slots[0].file && state.slots[1].file) || state.busy, onclick: runComparison },
    state.busy ? 'Comparing…' : 'Compare documents',
  );
  main.append(
    h(
      'section',
      { class: 'hero' },
      h('h1', null, 'Compare two versions of a document'),
      h(
        'p',
        null,
        'Drop in an original and a revised file — PDF, Word, HTML or text, in any combination. Differences are highlighted side by side.',
      ),
    ),
    h(
      'section',
      { class: 'slots' },
      slotCard(0),
      h(
        'button',
        {
          class: 'btn icon-btn swap',
          title: 'Swap original and revised',
          'aria-label': 'Swap original and revised',
          onclick: () => {
            state.slots.reverse();
            renderSetup();
          },
        },
        icon('swap', 18),
      ),
      slotCard(1),
    ),
    h(
      'section',
      { class: 'setup-actions' },
      optionsPanel(state.options, (o) => {
        setOptions(o);
        renderSetup();
      }),
      compareBtn,
      statusEl,
    ),
    h(
      'section',
      { class: 'trust' },
      trustItem('No upload', 'Documents are parsed and compared locally with JavaScript in this tab.'),
      trustItem('No storage', 'Nothing is saved. Starting a new comparison or closing the tab discards the files.'),
      trustItem('No third parties', 'A strict content-security policy blocks connections to any other server.'),
    ),
  );
}

function trustItem(title: string, text: string) {
  return h('div', { class: 'trust-item' }, icon('lock', 16), h('div', null, h('strong', null, title), h('p', null, text)));
}

function slotCard(side: Side): HTMLElement {
  const slot = state.slots[side];
  const label = side === 0 ? 'Original' : 'Revised';
  const input = h('input', {
    type: 'file',
    accept: ACCEPT,
    class: 'visually-hidden',
    'aria-label': `Choose ${label.toLowerCase()} document`,
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) setFile(side, f);
    },
  });

  const card = h(
    'label',
    { class: `slot ${slot.file ? 'filled' : ''} ${side === 0 ? 'left' : 'right'}` },
    input,
    h('span', { class: 'slot-label' }, label),
    slot.file
      ? h(
          'span',
          { class: 'slot-file' },
          icon('file', 28),
          h('span', { class: 'slot-name' }, slot.file.name),
          h('span', { class: 'slot-meta' }, formatBytes(slot.file.size)),
          h(
            'button',
            {
              class: 'btn ghost sm',
              onclick: (e: Event) => {
                e.preventDefault();
                state.slots[side] = { file: null, doc: null };
                renderSetup();
              },
            },
            icon('x', 14),
            'Remove',
          ),
        )
      : h(
          'span',
          { class: 'slot-empty' },
          icon('upload', 28),
          h('span', null, h('strong', null, 'Choose a file'), ' or drag it here'),
          h('span', { class: 'slot-meta' }, 'PDF · DOCX · HTML · TXT'),
        ),
  );

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('drag');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length >= 2) {
      // Two files dropped at once: fill both slots in drop order.
      setFile(0, files[0], false);
      setFile(1, files[1]);
    } else if (files[0]) setFile(side, files[0]);
  });
  return card;
}

function setFile(side: Side, file: File, rerender = true) {
  // Start extracting immediately so "Compare" feels instant.
  const doc = extractDocument(file, (msg) => (statusEl.textContent = msg));
  doc.catch(() => undefined); // surfaced when comparing
  state.slots[side] = { file, doc };
  statusEl.classList.remove('error');
  statusEl.textContent = '';
  if (rerender) renderSetup();
}

// ------------------------------------------------------------------ comparing

async function runComparison() {
  const [a, b] = state.slots;
  if (!a.file || !b.file || !a.doc || !b.doc) return;
  state.busy = true;
  renderSetup();
  statusEl.classList.remove('error');
  statusEl.textContent = 'Reading documents…';
  try {
    const docs = (await Promise.all([a.doc, b.doc])) as [ExtractedDoc, ExtractedDoc];
    statusEl.textContent = 'Comparing…';
    await nextFrame();
    state.docs = docs;
    state.result = compareDocuments(docs[0].blocks, docs[1].blocks, state.options);
    state.busy = false;
    showResults();
  } catch (err) {
    state.busy = false;
    renderSetup();
    statusEl.classList.add('error');
    statusEl.textContent =
      err instanceof ExtractionError ? err.message : 'Something went wrong while reading the documents.';
    if (!(err instanceof ExtractionError)) console.error(err);
  }
}

function recompare() {
  if (!state.docs) return;
  state.result = compareDocuments(state.docs[0].blocks, state.docs[1].blocks, state.options);
  viewer?.show(state.result, state.docs[0], state.docs[1]);
}

function showResults() {
  if (!state.result || !state.docs) return;
  clear(main);
  main.className = 'main results-mode';
  viewer = new Viewer({
    onNewComparison: () => {
      // Drop every reference to the documents so they can be garbage-collected.
      state.slots = [
        { file: null, doc: null },
        { file: null, doc: null },
      ];
      state.docs = null;
      state.result = null;
      renderSetup();
    },
    onSwap: () => {
      if (!state.docs) return;
      state.slots.reverse();
      state.docs = [state.docs[1], state.docs[0]];
      recompare();
    },
    onExportHtml: exportHtml,
    onExportCsv: () => {
      if (state.result) download(`${reportBase()}-differences.csv`, buildCsv(state.result), 'text/csv;charset=utf-8');
    },
    onPrint: () => window.print(),
    optionsPanel: () =>
      optionsPanel(state.options, (o) => {
        setOptions(o);
        recompare();
      }),
  });
  main.append(viewer.root);
  viewer.show(state.result, state.docs[0], state.docs[1]);
  if (state.result.changes.length) viewer.select(0);
}

async function exportHtml() {
  if (!state.result || !state.docs) return;
  const [la, lb] = await Promise.all(state.slots.map((s) => (s.file ? sha256(s.file) : undefined)));
  const html = buildHtmlReport(state.result, {
    left: { ...state.docs[0], sha256: la },
    right: { ...state.docs[1], sha256: lb },
    generatedAt: new Date(),
  });
  download(`${reportBase()}-report.html`, html, 'text/html;charset=utf-8');
}

function reportBase(): string {
  const stem = (n: string) => n.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 40);
  return state.docs ? `${stem(state.docs[0].name)}-vs-${stem(state.docs[1].name)}` : 'comparison';
}

// -------------------------------------------------------------------- helpers

function setOptions(o: CompareOptions) {
  state.options = o;
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

function loadOptions(): CompareOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      return {
        ignoreCase: !!saved.ignoreCase,
        ignorePunctuation: !!saved.ignorePunctuation,
        ignoreWhitespace: saved.ignoreWhitespace !== false,
        granularity: saved.granularity === 'char' ? 'char' : 'word',
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_OPTIONS };
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}
