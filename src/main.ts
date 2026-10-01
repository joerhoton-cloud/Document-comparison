import './styles.css';
import {
  renderCreateWorkspace,
  renderInvitation,
  renderPlan,
  renderResetPassword,
  renderSignIn,
} from './account/authScreens';
import { call } from './account/http';
import { changeKeys, reviewController, type ReviewSession } from './account/review';
import { hasActiveSubscription, type Me, type PublicConfig, type ReviewMark, type SaveLevel, type SavedComparison } from './account/types';
import { progressLabel, renderAccount, renderHistory, renderTeam, resumeDialog } from './account/workspacePages';
import { compareDocuments } from './compare/engine';
import { ACCEPT, extractDocument, ExtractionError } from './extract';
import { buildCsv, buildHtmlReport, buildTsv, download, sha256 } from './report';
import { sampleFiles } from './samples';
import { DEFAULT_OPTIONS, type CompareOptions, type CompareResult, type ExtractedDoc } from './types';
import { append, clear, formatBytes, h, icon, logo } from './ui/dom';
import { optionsPanel } from './ui/options';
import { Viewer } from './ui/viewer';

type Side = 0 | 1;
type Page = 'compare' | 'history' | 'team' | 'account';

interface Slot {
  file: File | null;
  doc: Promise<ExtractedDoc> | null;
  /** SHA-256 of the file, computed locally (used for duplicate detection; the file itself is never sent). */
  sha: Promise<string | undefined> | null;
}

const OPTIONS_KEY = 'doccompare.options';
const SAVE_LEVEL_KEY = 'doccompare.saveLevel';
/** The embedded (single-file) build runs in a sandbox: no downloads, printing or server. */
const STANDALONE = import.meta.env.MODE === 'artifact';
const CAN_DOWNLOAD = !STANDALONE;

const emptySlot = (): Slot => ({ file: null, doc: null, sha: null });

const state = {
  slots: [emptySlot(), emptySlot()] as [Slot, Slot],
  options: loadOptions(),
  result: null as CompareResult | null,
  docs: null as [ExtractedDoc, ExtractedDoc] | null,
  busy: false,
  saveLevel: loadSaveLevel(),
  /** Earlier saved comparisons of the currently selected files. */
  matches: [] as SavedComparison[],
  /** Saved comparison being continued (chosen from History or the "already compared" banner). */
  resume: null as SavedComparison | null,
  review: { saved: null, marks: new Map() } as ReviewSession,
};

let config: PublicConfig | null = null;
let me: Me | null = null;
let page: Page = 'compare';

const app = document.getElementById('app')!;
const topbar = h('header', { class: 'topbar' });
const main = h('main', { class: 'main' });
const statusEl = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
const bannerEl = h('div', { class: 'match-banner', hidden: true, role: 'status' });
let viewer: Viewer | null = null;

app.append(topbar, main);
void boot();

// ------------------------------------------------------------------- startup

async function boot() {
  if (STANDALONE) {
    renderTopbar();
    return renderSetup();
  }
  const params = new URLSearchParams(location.search);
  const [cfg] = await Promise.all([call<PublicConfig>('/api/config'), loadMe()]);
  config = cfg.ok ? cfg.data : { appName: 'DocCompare', providers: [], billingEnabled: false, trialDays: 0, prices: [] };
  renderTopbar();

  const token = params.get('token');
  if (params.has('reset') && token) return renderResetPassword(authRoot(), token, () => location.replace('/'));
  if (params.get('error')) {
    // e.g. an expired magic link or verification link
    history.replaceState(null, '', '/');
  }

  if (!me) return renderSignIn(authRoot(), config, () => location.reload());

  const invitation = params.get('invitation');
  if (invitation) return renderInvitation(authRoot(), invitation, () => location.replace('/'));

  if (!me.workspace) return renderCreateWorkspace(authRoot(), me, () => location.reload());

  if (params.get('billing') === 'success' && !hasActiveSubscription(me)) {
    // Stripe's webhook can arrive a moment after the redirect back.
    renderMessage('Finishing setup…', 'Confirming your subscription with Stripe.');
    for (let i = 0; i < 10 && !hasActiveSubscription(me); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await loadMe();
    }
  }
  if (params.has('billing') || params.has('page')) history.replaceState(null, '', '/');
  if (!hasActiveSubscription(me)) return renderPlan(authRoot(), me, config, signOut);

  go(params.get('page') === 'team' ? 'team' : 'compare');
}

async function loadMe() {
  const res = await call<Me>('/api/me');
  me = res.ok ? res.data : null;
}

function authRoot(): HTMLElement {
  viewer?.destroy();
  viewer = null;
  clear(main);
  main.className = 'main auth';
  renderTopbar();
  return main;
}

function renderMessage(title: string, text: string) {
  const root = authRoot();
  root.append(h('section', { class: 'auth-card' }, h('h1', null, title), h('p', { class: 'auth-sub' }, text)));
}

async function signOut() {
  await call('/api/auth/sign-out', { json: {} });
  location.replace('/');
}

// -------------------------------------------------------------- navigation

function renderTopbar() {
  clear(topbar);
  const ready = !!me?.workspace && hasActiveSubscription(me);
  const navBtn = (p: Page, label: string) =>
    h('button', { class: `nav-link${page === p ? ' active' : ''}`, 'aria-current': page === p ? 'page' : undefined, onclick: () => go(p) }, label);
  append(topbar, [
    h('div', { class: 'brand' }, logo(22), h('span', null, config?.appName ?? 'DocCompare')),
    ready && h('nav', { class: 'app-nav', 'aria-label': 'Main' }, navBtn('compare', 'Compare'), navBtn('history', 'History'), navBtn('team', 'Team')),
    h('div', { class: 'spacer' }),
    h(
      'div',
      { class: 'secure-badge', title: 'Files are read and compared inside this browser tab. They are never uploaded or stored.' },
      icon('lock', 14),
      'Files never leave your device',
    ),
    me &&
      h(
        'details',
        { class: 'menu user-menu' },
        h('summary', { class: 'btn ghost' }, h('span', { class: 'avatar sm', 'aria-hidden': 'true' }, me.user.name.slice(0, 1).toUpperCase()), h('span', { class: 'user-name' }, me.workspace?.name ?? me.user.name)),
        h(
          'div',
          { class: 'menu-items' },
          h('div', { class: 'menu-who' }, h('strong', null, me.user.name), h('span', null, me.user.email)),
          ready && h('button', { onclick: () => go('account') }, 'Account & security'),
          ready && h('button', { onclick: () => go('team') }, 'Team & billing'),
          h('button', { onclick: signOut }, 'Sign out'),
        ),
      ),
  ]);
  topbar.querySelector('.user-menu')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.menu-items button')) (e.currentTarget as HTMLDetailsElement).open = false;
  });
}

function go(p: Page) {
  page = p;
  renderTopbar();
  if (p === 'compare') return state.result ? showResults() : renderSetup();
  viewer?.destroy();
  viewer = null;
  clear(main);
  main.className = 'main page-mode';
  if (p === 'history') void renderHistory(main, me!, startResume);
  if (p === 'team') void renderTeam(main, me!, refreshMe);
  if (p === 'account') renderAccount(main, me!, refreshMe, signOut);
}

async function refreshMe() {
  await loadMe();
  renderTopbar();
}

// ------------------------------------------------------------ setup screen

function renderSetup() {
  viewer?.destroy();
  viewer = null;
  clear(main);
  main.className = 'main setup';
  const bothChosen = !!(state.slots[0].file && state.slots[1].file);
  const compareBtn = h(
    'button',
    { class: 'btn primary lg', disabled: !bothChosen || state.busy, onclick: () => runComparison() },
    state.busy ? 'Comparing…' : state.resume ? 'Continue review' : 'Compare documents',
  );
  main.append(
    h(
      'section',
      { class: 'hero' },
      h('h1', null, 'Compare two versions of a document'),
      h('p', null, 'Drop in an original and a revised file (PDF, scanned PDF, Word, image or text, in any combination). Differences are highlighted side by side.'),
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
            state.resume = null;
            renderSetup();
          },
        },
        icon('swap', 18),
      ),
      slotCard(1),
    ),
    bannerEl,
    h(
      'section',
      { class: 'setup-actions' },
      optionsPanel(state.options, (o) => {
        setOptions(o);
        renderSetup();
      }),
      me?.workspace && !state.resume && saveLevelPicker(),
      h(
        'div',
        { class: 'setup-buttons' },
        compareBtn,
        !state.resume &&
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                const [a, b] = sampleFiles();
                setFile(0, a, false);
                setFile(1, b, false);
                void runComparison();
              },
            },
            'Try the sample contracts',
          ),
        state.resume &&
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                state.resume = null;
                renderSetup();
              },
            },
            'Start a separate comparison instead',
          ),
      ),
      statusEl,
    ),
    h(
      'section',
      { class: 'trust' },
      trustItem('No upload', 'Documents are read and compared inside this browser tab. The server never receives them.'),
      trustItem(
        me?.workspace ? 'Saving is optional' : 'No storage',
        me?.workspace
          ? 'If you choose to save, only file names, sizes, fingerprints and your team’s review marks are stored.'
          : 'Nothing is saved. Starting a new comparison or closing the tab discards the files.',
      ),
      trustItem('No third parties', 'A strict content-security policy blocks connections to any other server.'),
    ),
  );
  renderBanner();
}

function trustItem(title: string, text: string) {
  return h('div', { class: 'trust-item' }, icon('lock', 16), h('div', null, h('strong', null, title), h('p', null, text)));
}

const SAVE_LEVELS: { value: SaveLevel; label: string; hint: string }[] = [
  { value: 'none', label: 'Don’t save', hint: 'Nothing is recorded. Only you see this comparison.' },
  { value: 'activity', label: 'Log activity', hint: 'Your team sees that you compared these files (names, sizes and fingerprints only).' },
  { value: 'progress', label: 'Save review progress', hint: 'Also saves which changes are reviewed or flagged, plus notes, so a teammate can pick up where you left off.' },
];

function saveLevelPicker(): HTMLElement {
  const hint = h('p', { class: 'save-hint' }, SAVE_LEVELS.find((l) => l.value === state.saveLevel)!.hint);
  return h(
    'fieldset',
    { class: 'save-picker' },
    h('legend', null, `Save to ${me!.workspace!.name}`),
    h(
      'div',
      { class: 'segmented', role: 'radiogroup' },
      ...SAVE_LEVELS.map((l) =>
        h(
          'label',
          { class: `seg${state.saveLevel === l.value ? ' on' : ''}` },
          h('input', {
            type: 'radio',
            name: 'save-level',
            value: l.value,
            checked: state.saveLevel === l.value,
            onchange: () => {
              state.saveLevel = l.value;
              storeSet(SAVE_LEVEL_KEY, l.value);
              renderSetup();
            },
          }),
          h('span', null, l.label),
        ),
      ),
    ),
    hint,
  );
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
                state.slots[side] = emptySlot();
                state.matches = [];
                state.resume = null;
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
          h('span', { class: 'slot-meta' }, 'PDF (incl. scans) · DOCX · Image · TXT'),
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
  // Start extracting (and fingerprinting) immediately so "Compare" feels instant.
  const doc = extractDocument(file, (msg) => (statusEl.textContent = msg));
  doc.catch(() => undefined); // surfaced when comparing
  state.slots[side] = { file, doc, sha: me?.workspace ? sha256(file).catch(() => undefined) : null };
  statusEl.classList.remove('error');
  statusEl.textContent = '';
  state.matches = [];
  if (!state.resume) void lookupEarlier();
  if (rerender) renderSetup();
}

/** Ask the server whether a teammate already compared these exact files (by fingerprint). */
async function lookupEarlier() {
  const [a, b] = state.slots;
  if (!me?.workspace || !a.sha || !b.sha) return;
  const [la, lb] = await Promise.all([a.sha, b.sha]);
  if (!la || !lb || state.slots[0] !== a || state.slots[1] !== b) return;
  const res = await call<{ matches: SavedComparison[] }>(`/api/comparisons/lookup?left=${la}&right=${lb}`);
  if (!res.ok || state.slots[0] !== a) return;
  state.matches = res.data.matches;
  renderBanner();
}

function renderBanner() {
  clear(bannerEl);
  const m = state.matches[0];
  bannerEl.hidden = !m || !!state.resume || state.busy;
  if (!m || state.resume) return;
  const who = m.created_by === me?.user.id ? 'You' : m.created_by_name;
  bannerEl.append(
    icon('file', 18),
    h(
      'div',
      null,
      h('strong', null, `${who} already compared these files ${new Date(m.created_at).toLocaleDateString()}`),
      h('span', null, ` · ${m.stats.total} differences · ${progressLabel(m)}${state.matches.length > 1 ? ` · ${state.matches.length} saved comparisons` : ''}`),
    ),
    h('button', { class: 'btn primary sm', onclick: () => continueSaved(m) }, m.save_level === 'progress' ? 'Continue their review' : 'Open it'),
  );
}

// -------------------------------------------------------------- comparing

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
    if (state.resume) state.options = { ...DEFAULT_OPTIONS, ...state.resume.options };
    state.result = compareDocuments(docs[0].blocks, docs[1].blocks, state.options);
    await attachSaved();
    state.busy = false;
    showResults();
  } catch (err) {
    state.busy = false;
    renderSetup();
    statusEl.classList.add('error');
    statusEl.textContent = err instanceof ExtractionError ? err.message : 'Something went wrong while reading the documents.';
    if (!(err instanceof ExtractionError)) console.error(err);
  }
}

/** Link the fresh result to a saved comparison: continue one, or create one if the user chose to save. */
async function attachSaved() {
  state.review = { saved: null, marks: new Map() };
  if (!me?.workspace) return;
  if (state.resume) {
    const res = await call<{ comparison: SavedComparison; reviews: ReviewMark[] }>(`/api/comparisons/${state.resume.id}`);
    if (res.ok) {
      state.review = { saved: res.data.comparison, marks: new Map(res.data.reviews.map((r) => [r.change_key, r])) };
      void call(`/api/comparisons/${state.resume.id}/open`, { json: {} });
    }
    state.resume = null;
    return;
  }
  if (state.saveLevel !== 'none') await createSaved(state.saveLevel);
}

async function createSaved(level: 'activity' | 'progress'): Promise<boolean> {
  const [a, b] = state.slots;
  if (!state.result || !state.docs || !a.file || !b.file) return false;
  const [la, lb] = await Promise.all([a.sha ?? sha256(a.file), b.sha ?? sha256(b.file)]);
  if (!la || !lb) return false;
  const s = state.result.stats;
  const file = (f: File, d: ExtractedDoc, sha: string) => ({ name: f.name.slice(0, 255), sha256: sha, size: f.size, format: d.format });
  const res = await call<{ comparison: SavedComparison }>('/api/comparisons', {
    json: {
      left: file(a.file, state.docs[0], la),
      right: file(b.file, state.docs[1], lb),
      options: state.result.options,
      stats: { total: s.total, inserted: s.inserted, deleted: s.deleted, replaced: s.replaced, similarity: s.similarity },
      saveLevel: level,
    },
  });
  if (!res.ok) {
    statusEl.textContent = `Couldn’t save to history: ${res.message}`;
    return false;
  }
  state.review = { saved: res.data.comparison, marks: new Map() };
  return true;
}

function recompare() {
  if (!state.docs) return;
  state.result = compareDocuments(state.docs[0].blocks, state.docs[1].blocks, state.options);
  viewer?.show(state.result, state.docs[0], state.docs[1]);
  attachReviewToViewer();
}

function attachReviewToViewer() {
  if (!viewer || !state.result || !me?.workspace) return;
  viewer.setReview(
    reviewController(state.result, state.review, me.workspace.name, me.user.name, async () => {
      const saved = state.review.saved;
      if (saved) {
        const res = await call(`/api/comparisons/${saved.id}`, { method: 'PATCH', json: { saveLevel: 'progress' } });
        if (res.ok) state.review.saved = { ...saved, save_level: 'progress' };
      } else {
        await createSaved('progress');
      }
      attachReviewToViewer();
    }),
  );
}

function showResults() {
  if (!state.result || !state.docs) return;
  page = 'compare';
  renderTopbar();
  viewer?.destroy();
  clear(main);
  main.className = 'main results-mode';
  viewer = new Viewer({
    onNewComparison: () => {
      // Drop every reference to the documents so they can be garbage-collected.
      state.slots = [emptySlot(), emptySlot()];
      state.docs = null;
      state.result = null;
      state.matches = [];
      state.review = { saved: null, marks: new Map() };
      renderSetup();
    },
    onSwap: () => {
      if (!state.docs) return;
      state.slots.reverse();
      state.docs = [state.docs[1], state.docs[0]];
      // A swapped comparison is a different comparison: stop writing to the saved one.
      state.review = { saved: null, marks: new Map() };
      recompare();
    },
    onExportHtml: exportHtml,
    onExportCsv: () => {
      if (state.result) download(`${reportBase()}-differences.csv`, buildCsv(state.result), 'text/csv;charset=utf-8');
    },
    onPrint: () => window.print(),
    canDownload: CAN_DOWNLOAD,
    onCopy: async () => {
      if (!state.result) return false;
      try {
        await navigator.clipboard.writeText(buildTsv(state.result));
        return true;
      } catch {
        return false;
      }
    },
    optionsPanel: () =>
      optionsPanel(state.options, (o) => {
        setOptions(o);
        recompare();
      }),
  });
  main.append(viewer.root);
  viewer.show(state.result, state.docs[0], state.docs[1]);
  attachReviewToViewer();
  // Start at the first change nobody has marked yet (flagged ones already have an owner).
  const keys = changeKeys(state.result);
  const firstOpen = state.result.changes.find((c) => !state.review.marks.has(keys.get(c.id)!)) ?? state.result.changes[0];
  if (firstOpen) viewer.select(firstOpen.id);
}

// ---------------------------------------------------------- resuming work

/** From History: pick the same two files again, then continue. */
function startResume(c: SavedComparison) {
  const dialog = resumeDialog(
    c,
    (f) => sha256(f),
    (left, right) => {
      dialog.remove();
      state.resume = c;
      state.slots = [emptySlot(), emptySlot()];
      setFile(0, left, false);
      setFile(1, right, false);
      page = 'compare';
      renderTopbar();
      void runComparison();
    },
    () => dialog.remove(),
  );
  document.body.append(dialog);
}

/** From the "already compared" banner: the files are already selected. */
function continueSaved(c: SavedComparison) {
  // The banner matches either order; keep the saved orientation.
  void Promise.resolve(state.slots[0].sha).then((la) => {
    if (la === c.right_sha256 && la !== c.left_sha256) state.slots.reverse();
    state.resume = c;
    void runComparison();
  });
}

async function exportHtml() {
  if (!state.result || !state.docs) return;
  const [la, lb] = await Promise.all(state.slots.map((s) => (s.file ? (s.sha ?? sha256(s.file)) : undefined)));
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

// ---------------------------------------------------------------- helpers

function setOptions(o: CompareOptions) {
  state.options = o;
  storeSet(OPTIONS_KEY, JSON.stringify(o));
}

function storeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference just won't persist */
  }
}

function loadSaveLevel(): SaveLevel {
  try {
    const v = localStorage.getItem(SAVE_LEVEL_KEY);
    if (v === 'activity' || v === 'progress') return v;
  } catch {
    /* ignore */
  }
  return 'none';
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
