# Security

## Data flow

```
 user's disk ──(File API)──▶ browser tab memory ──▶ PDF.js worker / mammoth / diff ──▶ rendered view
                                                                               └──▶ optional export (download to disk)
```

Document bytes, extracted text and comparison results exist only in the memory of the tab that opened them. The server handles accounts, workspaces, billing and, **only when a user opts in**, comparison metadata:

| Stored when saving is on | Never stored |
|---|---|
| File names and sizes | File contents |
| SHA-256 fingerprints of each file | Extracted text |
| Difference counts and similarity % | The differences themselves |
| Comparison settings | Page images |
| Review marks, keyed by a hash of each change | |
| Notes people type on changes | |
| Who did what, and when (activity log) | |

There is no upload endpoint. API request bodies are capped at 64 KB, and there is no telemetry.

## Controls

| Risk | Control |
|---|---|
| Document exfiltration by the page | CSP `default-src 'self'; connect-src 'self'`, with no third-party origins. This is enforced by the browser and verified in e2e tests, which record every network request. |
| Malicious PDF | Patched PDF.js (≥ 6.2.108; legacy build for older browsers). Runs in a Web Worker, with XFA and font-face loading disabled. Only pages without a text layer are rendered, to an off-screen canvas for OCR. |
| Scans and OCR | Text recognition (Tesseract WebAssembly) runs in a Web Worker in the browser, from files served by this origin. Scanned pages are never uploaded. The English model is cached in the browser's storage; it contains no document data. |
| Malicious DOCX/HTML | Converted to an inert DOM via `DOMParser`, where scripts never execute. Only `textContent` is read. Images are dropped. |
| XSS through document text | All document text goes into the page with `textContent` or text nodes. The UI has no `innerHTML`. The exported report HTML-escapes all content and carries its own `default-src 'none'` CSP. |
| CSV formula injection | Cells beginning with `= + - @` are prefixed with `'`. |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| Leakage via referrer/indexing | `Referrer-Policy: no-referrer`, `noindex`. |
| Oversized input | 100 MB per-file limit. |
| Account takeover | Passwords of 12+ characters (hashed with scrypt by Better Auth); email verification before password sign-in; optional TOTP two-step verification; rate limits on sign-in, sign-up, reset and 2FA endpoints; sessions expire after 7 days; password reset revokes sessions. |
| Cross-workspace access | Every API query is filtered by the caller's active workspace *and* membership is re-checked on each request. Integration tests cover reads, writes and deletes from another workspace. |
| CSRF | Session cookies are `SameSite=Lax`, and all non-GET API requests must carry this app's exact `Origin`. |
| Billing abuse | Only owners/admins can start or change subscriptions (`authorizeReference`). Stripe webhooks are signature-verified, and access follows the webhook-synced subscription status, never the checkout return page. Workspaces without an active or trial subscription get `402` from every workspace API. |
| Stripe key exposure | A restricted key (`rk_`) with least-privilege permissions is recommended. A live key is refused outside production. A pre-commit hook blocks commits containing Stripe keys, webhook secrets or `.env` files. |
| Supply chain | Browser code uses five libraries (`pdfjs-dist`, `mammoth`, `diff`, `qrcode-generator`, `tesseract.js`). The server uses `better-auth`, `hono`, `pg`/`kysely`, `stripe` and `zod`. Versions are pinned in a lockfile, and CI runs `npm audit --audit-level=high`. |

## Access control

Sign-in is required, with email + password, a one-time email link, or Microsoft/Google. Roles:

| Role | Can |
|---|---|
| Owner | Everything, including billing and deleting the workspace. |
| Admin | Invite and remove members, manage billing, delete anyone's saved comparisons. |
| Member | Compare, save, review, see the team history, and delete their own saved comparisons. |

If a customer needs their identity provider to control access, restrict Microsoft sign-in to their tenant (`MICROSOFT_TENANT_ID`). SAML/Okta SSO can be added with Better Auth's SSO plugin.

## Operations

- Set a long random `BETTER_AUTH_SECRET` (`openssl rand -base64 48`) and keep it secret; rotating it signs everyone out.
- Serve over HTTPS only. Secure cookies and HSTS are enabled when `NODE_ENV=production`.
- Set `CLIENT_IP_HEADER` to the header your load balancer sets, and make sure the app is reachable only through it; otherwise clients could spoof their IP to dodge rate limits.
- Back up Postgres. It holds accounts and saved metadata only, so a leak would expose file names and notes, not documents.

## Reporting a vulnerability

Email the maintainer rather than opening a public issue.
