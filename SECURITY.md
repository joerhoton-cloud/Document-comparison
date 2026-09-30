# Security

## Data flow

```
 user's disk ──(File API)──▶ browser tab memory ──▶ PDF.js worker / mammoth / diff ──▶ rendered view
                                                                               └──▶ optional export (download to disk)
```

The server only serves static HTML/JS/CSS. There is no API, database, upload endpoint or telemetry. Document bytes, extracted text and comparison results exist only in the memory of the tab that opened them.

## Controls

| Risk | Control |
|---|---|
| Document exfiltration by the page | CSP `default-src 'self'; connect-src 'self'`, with no third-party origins. This is enforced by the browser and verified in e2e tests, which record every network request. |
| Malicious PDF | Patched PDF.js (≥ 6.2.108). Runs in a Web Worker, extracts text only (no rendering), with XFA and font-face loading disabled. |
| Malicious DOCX/HTML | Converted to an inert DOM via `DOMParser`, where scripts never execute. Only `textContent` is read. Images are dropped. |
| XSS through document text | All document text goes into the page with `textContent` or text nodes. The UI has no `innerHTML`. The exported report HTML-escapes all content and carries its own `default-src 'none'` CSP. |
| CSV formula injection | Cells beginning with `= + - @` are prefixed with `'`. |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| Leakage via referrer/indexing | `Referrer-Policy: no-referrer`, `noindex`. |
| Oversized input | 100 MB per-file limit. |
| Supply chain | Three runtime dependencies (`pdfjs-dist`, `mammoth`, `diff`), a lockfile, and `npm audit --audit-level=high` in CI. |

## Access control

The app has no built-in login, by design: it holds no data worth protecting server-side. Restrict access at the edge with SSO (see "Offering it to Cision" in the README).

## Reporting a vulnerability

Email the maintainer rather than opening a public issue.
