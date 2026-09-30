import type { ChangeType, CompareResult, ExtractedDoc, Segment } from './types';

export interface ReportMeta {
  left: ExtractedDoc & { sha256?: string };
  right: ExtractedDoc & { sha256?: string };
  generatedAt: Date;
}

const LABEL: Record<ChangeType, string> = { replaced: 'Changed', inserted: 'Added', deleted: 'Removed' };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const segsHtml = (segs: Segment[]) =>
  segs
    .map((s) => (s.op === 'eq' ? esc(s.text) : `<${s.op}>${esc(s.text)}</${s.op}>`))
    .join('');

/** A self-contained HTML report (no external resources, no scripts). */
export function buildHtmlReport(result: CompareResult, meta: ReportMeta): string {
  const { stats, options } = result;
  const opts = [
    options.ignoreCase && 'ignore case',
    options.ignorePunctuation && 'ignore punctuation',
    options.ignoreWhitespace && 'ignore spacing',
    `${options.granularity}-level highlighting`,
  ]
    .filter(Boolean)
    .join(', ');

  const docRow = (label: string, d: ReportMeta['left']) =>
    `<tr><th>${label}</th><td>${esc(d.name)}</td><td>${d.format.toUpperCase()}</td><td>${d.size.toLocaleString()} bytes</td><td class="mono">${esc(d.sha256 ?? 'n/a')}</td></tr>`;

  const changeRows = result.changes
    .map(
      (c) => `<tr class="${c.type}">
  <td><a href="#r${c.row}">${c.id + 1}</a></td>
  <td><span class="badge ${c.type}">${LABEL[c.type]}</span></td>
  <td>${c.leftPage || c.rightPage ? `${c.leftPage ?? '–'} / ${c.rightPage ?? '–'}` : ''}</td>
  <td>${c.context ? `<span class="ctx">${esc(c.context)}</span> ` : ''}${c.leftText.trim() ? `<del>${esc(c.leftText)}</del>` : ''}</td>
  <td>${c.context && !c.leftText.trim() ? `<span class="ctx">${esc(c.context)}</span> ` : ''}${c.rightText.trim() ? `<ins>${esc(c.rightText)}</ins>` : ''}</td>
</tr>`,
    )
    .join('\n');

  const bodyRows = result.rows
    .map((r, i) => {
      const page = (p?: number) => (p ? `<span class="pg">p.${p}</span>` : '');
      return `<tr class="${r.type}" id="r${i}">
  <td class="l">${r.left ? page(r.left.page) + segsHtml(r.leftSegs) : ''}</td>
  <td class="r">${r.right ? page(r.right.page) + segsHtml(r.rightSegs) : ''}</td>
</tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comparison report — ${esc(meta.left.name)} vs ${esc(meta.right.name)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2433;margin:32px auto;max-width:1200px;padding:0 24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}
.sub{color:#5b6477;margin:0 0 20px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe3eb;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f4f6fa;font-weight:600}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{border:1px solid #dfe3eb;border-radius:8px;padding:8px 14px}.stat b{display:block;font-size:20px}
del{background:#fde2e1;color:#9b1c1c;text-decoration:line-through;text-decoration-color:#d64545}
ins{background:#d8f5e5;color:#0c5c36;text-decoration:none}
.badge{font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;white-space:nowrap}
.badge.replaced{background:#fff1cc;color:#7a5200}.badge.inserted{background:#d8f5e5;color:#0c5c36}.badge.deleted{background:#fde2e1;color:#9b1c1c}
.ctx{color:#7a8294}
.doc td{width:50%;white-space:pre-wrap}
.doc tr.equal td{color:#3c4456}
.doc tr.inserted td.r,.doc tr.deleted td.l{background:#fafbfd}
.doc tr.inserted td.l,.doc tr.deleted td.r{background:repeating-linear-gradient(45deg,#f7f8fb,#f7f8fb 6px,#eef0f5 6px,#eef0f5 12px)}
.pg{float:right;font-size:11px;color:#8a92a3;margin-left:8px}
.foot{margin-top:32px;color:#7a8294;font-size:12px}
@media print{body{margin:0;max-width:none}a{color:inherit}tr{break-inside:avoid}}
</style></head><body>
<h1>Document comparison report</h1>
<p class="sub">Generated ${esc(meta.generatedAt.toLocaleString())} · Options: ${esc(opts)}</p>
<table>
<tr><th></th><th>File</th><th>Format</th><th>Size</th><th>SHA-256</th></tr>
${docRow('Original', meta.left)}
${docRow('Revised', meta.right)}
</table>
<h2>Summary</h2>
<div class="stats">
<div class="stat"><b>${stats.total}</b>differences</div>
<div class="stat"><b>${stats.replaced}</b>changed</div>
<div class="stat"><b>${stats.inserted}</b>added</div>
<div class="stat"><b>${stats.deleted}</b>removed</div>
<div class="stat"><b>${(stats.similarity * 100).toFixed(1)}%</b>words unchanged</div>
</div>
<h2>List of differences</h2>
${result.changes.length ? `<table><tr><th>#</th><th>Type</th><th>Page</th><th>Original</th><th>Revised</th></tr>\n${changeRows}</table>` : '<p>No differences found.</p>'}
<h2>Side-by-side</h2>
<table class="doc"><tr><th>Original — ${esc(meta.left.name)}</th><th>Revised — ${esc(meta.right.name)}</th></tr>
${bodyRows}
</table>
<p class="foot">Produced by DocCompare. Documents were processed locally in the browser; no content was uploaded.</p>
</body></html>`;
}

const csvCell = (s: string | number | undefined) => {
  let v = String(s ?? '').replace(/\s+/g, ' ').trim();
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return `"${v.replace(/"/g, '""')}"`;
};

export function buildCsv(result: CompareResult): string {
  const header = ['#', 'Type', 'Original page', 'Revised page', 'Context', 'Original text', 'Revised text'];
  const lines = result.changes.map((c) =>
    [c.id + 1, LABEL[c.type], c.leftPage, c.rightPage, c.context, c.leftText, c.rightText].map(csvCell).join(','),
  );
  // BOM so Excel detects UTF-8.
  return '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
}

/** Tab-separated list of differences, for pasting into a spreadsheet or email. */
export function buildTsv(result: CompareResult): string {
  const cell = (v: string | number | undefined) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const rows = result.changes.map((c) =>
    [c.id + 1, LABEL[c.type], c.leftPage, c.rightPage, c.leftText, c.rightText].map(cell).join('\t'),
  );
  return [['#', 'Type', 'Original page', 'Revised page', 'Original text', 'Revised text'].join('\t'), ...rows].join('\n');
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function sha256(file: File): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined; // only available in secure contexts
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
