# DocCompare: secure side-by-side document comparison

A web app for comparing two versions of a document, modeled on the "Compare Documents" feature in ABBYY FineReader PDF. Everything runs **inside the user's browser**: files are never uploaded, stored or sent to a third party.

![Side-by-side comparison](docs/screenshot.png)

## Features

| | |
|---|---|
| **Formats** | PDF (text-based), Word `.docx`, HTML, plain text/Markdown. Any combination, e.g. PDF vs Word. |
| **Side-by-side view** | Original and revised are shown in aligned rows. Changed paragraphs line up; added and removed paragraphs sit next to a hatched gap. |
| **Highlighting** | Removed text is red with strikethrough, added text is green, and changed paragraphs get an amber margin bar. Highlighting can be word-level or character-level. |
| **List of differences** | Every change is listed with its type (Changed / Added / Removed), page number and surrounding context. Click an item to jump to it. |
| **Navigation** | Previous/next buttons and the keyboard shortcuts `j`/`k`, `↓`/`↑` or `n`/`p`. Clicking a highlight selects it. |
| **Filters** | Show or hide each change type. "Changes only" collapses unchanged paragraphs. |
| **Comparison settings** | Ignore case, ignore punctuation, ignore spacing/line wrapping. Curly and straight quotes and dash variants are always treated as equal. |
| **Export** | A self-contained HTML report (summary, list of differences, full side-by-side view and **SHA-256 hashes** of both files for audit), a CSV of the differences, or Print / Save as PDF. |
| **Smart grouping** | Similar paragraphs are paired even when paragraphs are inserted around them. Amounts like `$48,000` or `7:00` are treated as single words. Edits separated only by punctuation (`twelve (12)` → `twenty-four (24)`) count as one change. |

Not included yet: OCR for scanned PDFs (the app detects them and asks for an OCR'd copy), legacy `.doc` files, and formatting-only changes such as bold or font.

## Security model

- **Client-side only.** PDF parsing (PDF.js), Word parsing (mammoth) and the diff all run in the browser tab. The server only delivers static files.
- **No outbound connections.** A strict Content-Security-Policy (`connect-src 'self'`, no third-party scripts, fonts or CDNs) makes it technically impossible for the page to send document content elsewhere. PDF.js workers, fonts and character maps are bundled and served from the same origin.
- **No persistence.** Documents are held in memory only. Clicking "New" drops them. Only the comparison settings (checkboxes) are saved, in `localStorage`.
- **No markup injection.** Document text is always inserted as text nodes, never as HTML. HTML and DOCX input is parsed into an inert DOM (scripts never run). CSV exports are protected against spreadsheet formula injection.
- **Hardened PDF parsing.** PDF.js is pinned to a patched release (≥ 6.2.108, fixing GHSA-hq66-cqwq-w95j), with XFA and font-face loading disabled. `npm audit` runs in CI.
- **Hardened server.** The nginx config sends CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and COOP/CORP headers. It rejects non-GET requests and request bodies, and runs as a non-root user.

The e2e test suite checks that comparing documents makes **zero** requests to any other origin and triggers no CSP violations.

See [SECURITY.md](SECURITY.md) for deployment guidance.

## Getting started

Requires Node.js 22+.

```bash
npm install
npm run dev          # http://localhost:5173
```

Sample contracts to try are in [`samples/`](samples/) (regenerate them with `python3 samples/generate.py`).

```bash
npm test             # unit tests (diff engine, PDF layout analysis)
npm run test:e2e     # browser tests (Playwright) against a production build
npm run build        # static site in dist/
```

## Deploying

The build output in `dist/` is a static site, so any static host works. For the recommended hardened setup:

```bash
docker build -t doccompare .
docker run -p 8080:8080 doccompare     # http://localhost:8080, health check at /healthz
```

The image is `nginx-unprivileged` serving `dist/` with [`deploy/nginx.conf`](deploy/nginx.conf) and [`deploy/security-headers.conf`](deploy/security-headers.conf). Put it behind your TLS terminator.

### Offering it to Cision (or another organization)

Because no document ever reaches the server, the server needs no document storage, retention policy or data-processing review. To restrict who can open the app:

1. **Put it behind SSO.** Place the container behind your identity-aware proxy, e.g. Okta or Entra ID through [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/), Cloudflare Access, Azure App Proxy or Google IAP. The app needs no code changes for this.
2. **Host it on an internal domain** over HTTPS. `crypto.subtle`, used for the report's SHA-256 hashes, needs a secure context.
3. Optionally **pin the image digest** and rebuild on dependency updates. Dependabot or Renovate plus the CI workflow cover this.

## Project layout

```
src/
  compare/engine.ts     paragraph alignment + word/char diff, change numbering
  compare/normalize.ts  tokenizer, normalization options, similarity
  extract/              PDF (pdf.js + layout analysis), DOCX (mammoth), HTML, text
  ui/viewer.ts          side-by-side view, differences list, navigation
  report.ts             HTML/CSV export
deploy/                 nginx config and security headers
e2e/                    Playwright tests
tests/                  Vitest unit tests
```

### How the comparison works

1. Each file is converted into **blocks**: paragraphs, headings, list items and table cells. For PDFs, text runs are regrouped into lines and paragraphs using their position, gaps between lines and font size. Hyphenation and paragraphs that continue across a page break are rejoined.
2. Blocks are normalized according to the settings and aligned with an LCS diff.
3. Within each run of removed and added blocks, pairs are matched by word similarity using an order-preserving optimal alignment. A matched pair becomes a *modified* paragraph; unmatched blocks are *added* or *removed*.
4. Modified paragraphs get a word-level (or character-level) diff. Adjacent edits become numbered changes that are linked across both sides, the list and the report.
