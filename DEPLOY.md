# Deploying DocCompare to production (Render)

This sets up a live, HTTPS copy of DocCompare for testing: sign-in, team workspaces,
comparisons, saved reviews and history. Billing is **off**. About 15 minutes, and roughly
**$13/month** (Render Starter web service $7 + Basic Postgres $6).

## 1. Create a Gmail app password (for sign-in and invitation emails)

The app emails people confirmation links, sign-in links and team invitations. The quickest
way to send them is through a Gmail account.

1. Sign in to the Google account that should send the emails.
2. Turn on 2-Step Verification if it isn't already: <https://myaccount.google.com/security>.
3. Open <https://myaccount.google.com/apppasswords>, create an app password named
   "DocCompare", and copy the 16-character password (no spaces).
4. Your three settings:

   ```
   SMTP_USER  = you@gmail.com
   SMTP_PASS  = the 16-letter app password (spaces are fine)
   EMAIL_FROM = DocCompare <you@gmail.com>
   ```

Gmail sends up to about 500 emails a day, which is plenty for testing. For a customer
launch, switch to Resend with your own domain (see `.env.example`).

## 2. Deploy on Render

1. Create a free account at <https://render.com> and choose **Sign in with GitHub**.
2. Open this link and authorize access to the repository when asked:

   **<https://render.com/deploy?repo=https://github.com/joerhoton-cloud/Document-comparison/tree/claude/document-comparison-tool-hmfnz0>**

   (Or: Render Dashboard → **New** → **Blueprint** → pick `Document-comparison` and the
   `claude/document-comparison-tool-hmfnz0` branch.)
3. Render reads `render.yaml` and shows a web service `doccompare` and a database
   `doccompare-db`. Paste the `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` values from step 1, then click
   **Deploy Blueprint**.
4. The first build takes about 5 minutes. When the service shows **Live**, open its
   `https://doccompare-xxxx.onrender.com` address.

Render detects the public address, generates the session secret, keeps the database
private, and redeploys automatically on every push to the branch.

## 3. Try it

1. **Create an account** with your email, then click the confirmation link in your inbox
   (check spam the first time).
2. **Create a workspace**, e.g. "Cision Legal".
3. **Compare**: click *Try the sample contracts*, or drop in two versions of your own
   document. Pick *Save review progress* first if you want to try the team features.
4. **Invite a colleague** from the **Team** page. They create an account with the invited
   email address, follow the link and join.
5. **Hand-off**: your colleague selects the same two files and gets a banner to continue
   your review. The **History** page shows who did what.
6. Optional: **Account & security** → turn on two-step verification.

Documents never reach the server, including in production: only file names, sizes,
fingerprints and review marks are saved, and only when someone chooses to save.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails with `Set RESEND_API_KEY or SMTP_URL` or an `SMTP_` setting error | Add `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` under the service's **Environment** tab, then **Manual Deploy**. |
| No confirmation email arrives | Check spam. In the service **Logs**, find the `[email] SMTP login …` line after startup. `FAILED` means the app password is wrong: create a new one and update `SMTP_PASS`. Then sign in again to get a fresh link. |
| "Too many requests" when signing up | Sign-ups are limited to 5 per minute per address, as a security measure. Wait a minute. |
| You want your own domain | Service → **Settings** → **Custom Domains**, add e.g. `compare.yourcompany.com`, create the DNS record Render shows, then set `BASE_URL=https://compare.yourcompany.com` under **Environment**. |

## Later: turning on billing

When you're ready to charge customers:
1. Run `npm run stripe:setup` with your Stripe key (see the README).
2. In the service's **Environment** tab, delete `BILLING_DISABLED` and add
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM` and
   `STRIPE_PRICE_UNLIMITED`.
3. Add a webhook endpoint in Stripe at `https://<your-address>/api/auth/stripe/webhook`.
