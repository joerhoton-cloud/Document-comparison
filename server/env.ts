/** Server configuration, read once from environment variables. */
function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === 'production';

export const env = {
  isProd,
  port: Number(process.env.PORT ?? 3000),
  /** Public URL of the app, e.g. https://compare.example.com (no trailing slash). */
  // Render sets RENDER_EXTERNAL_URL automatically, so BASE_URL can be left unset there.
  baseUrl: required('BASE_URL', process.env.RENDER_EXTERNAL_URL ?? (isProd ? undefined : 'http://localhost:3000')).replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL', isProd ? undefined : 'postgres://postgres@localhost:5433/doccompare'),
  authSecret: required('BETTER_AUTH_SECRET', isProd ? undefined : 'dev-only-secret-change-me-dev-only-secret'),
  appName: process.env.APP_NAME ?? 'DocCompare',
  /** Extra origins allowed to call the API (the Vite dev server in development). */
  devOrigins: isProd ? [] : ['http://localhost:5173'],

  google: process.env.GOOGLE_CLIENT_ID
    ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: required('GOOGLE_CLIENT_SECRET') }
    : undefined,
  microsoft: process.env.MICROSOFT_CLIENT_ID
    ? {
        clientId: process.env.MICROSOFT_CLIENT_ID,
        clientSecret: required('MICROSOFT_CLIENT_SECRET'),
        tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common',
      }
    : undefined,

  /**
   * Header carrying the real client IP, set by your load balancer (used for rate limiting).
   * Only trust it when the app is reachable exclusively through that proxy.
   */
  // On Render (which sets RENDER=true) traffic passes through Cloudflare, which sets
  // CF-Connecting-IP to the visitor's address; X-Forwarded-For there has several hops.
  clientIpHeaders: (process.env.CLIENT_IP_HEADER ?? (process.env.RENDER ? 'cf-connecting-ip,true-client-ip,x-forwarded-for' : 'x-forwarded-for'))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  /** Automated tests create many accounts from one address; never honoured in production. */
  disableRateLimit: !isProd && process.env.DISABLE_RATE_LIMIT === 'true',

  /** Transactional email via Resend. Without it, emails are printed to the server log (dev only). */
  resendApiKey: process.env.RESEND_API_KEY,
  /**
   * Or any SMTP server, e.g. Gmail with an app password:
   * smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465
   */
  smtp: smtpConfig(),
  emailFrom: process.env.EMAIL_FROM ?? 'DocCompare <no-reply@example.com>',

  stripe: process.env.STRIPE_SECRET_KEY
    ? {
        /** Prefer a restricted key (rk_…) with only the permissions listed in .env.example. */
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
        /** Flat monthly prices: Team (up to 5 members) and Unlimited. */
        teamPriceId: required('STRIPE_PRICE_TEAM'),
        unlimitedPriceId: required('STRIPE_PRICE_UNLIMITED'),
        trialDays: Number(process.env.TRIAL_DAYS ?? 14),
        /**
         * Stripe Tax. Only turn on after adding a tax registration in the Dashboard:
         * without one, Stripe silently collects no tax.
         */
        automaticTax: process.env.STRIPE_AUTOMATIC_TAX === 'true',
        /** Tests only: send Stripe API calls to stripe-mock (e.g. http://localhost:12111). */
        apiBase: isProd ? undefined : process.env.STRIPE_API_BASE,
      }
    : undefined,
};

if (env.stripe && /^[sr]k_live_/.test(env.stripe.secretKey) && !isProd)
  throw new Error('A live Stripe key is configured outside production. Use a sandbox (test) key for development.');
if (isProd && env.stripe && /^sk_/.test(env.stripe.secretKey))
  console.warn('[stripe] Using an unrestricted secret key. Create a restricted key (rk_) with only the needed permissions.');

if (isProd && !env.resendApiKey && !env.smtp)
  throw new Error('Set RESEND_API_KEY or SMTP_URL: production needs email for sign-in links, confirmations and invitations.');
if (isProd && !env.stripe && process.env.BILLING_DISABLED !== 'true')
  throw new Error('Stripe is not configured. Set STRIPE_* variables, or BILLING_DISABLED=true to run without billing.');

/**
 * SMTP settings, from either SMTP_USER + SMTP_PASS (host defaults to Gmail) or SMTP_URL.
 * Invalid values are reported without echoing them, since they contain a password.
 */
function smtpConfig() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, ''); // Gmail shows app passwords in groups of 4
  if (user || pass) {
    if (!user || !pass) throw new Error('Set both SMTP_USER (your email address) and SMTP_PASS (its app password).');
    if (!user.includes('@')) throw new Error('SMTP_USER must be a full email address, e.g. you@gmail.com.');
    const port = Number(process.env.SMTP_PORT ?? 465);
    return { host: process.env.SMTP_HOST ?? 'smtp.gmail.com', port, secure: port === 465, user, pass };
  }
  const raw = process.env.SMTP_URL?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    u = new URL('invalid:');
  }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:' || !u.hostname || !u.username || !u.password)
    throw new Error(
      'SMTP_URL is not in the expected format (smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465). ' +
        'Simpler: delete SMTP_URL and set SMTP_USER and SMTP_PASS instead.',
    );
  const port = Number(u.port || (u.protocol === 'smtps:' ? 465 : 587));
  return {
    host: u.hostname,
    port,
    secure: u.protocol === 'smtps:',
    user: decodeURIComponent(u.username),
    pass: decodeURIComponent(u.password).replace(/\s+/g, ''),
  };
}
