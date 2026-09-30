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
  baseUrl: required('BASE_URL', isProd ? undefined : 'http://localhost:3000').replace(/\/$/, ''),
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
  clientIpHeader: process.env.CLIENT_IP_HEADER ?? 'x-forwarded-for',

  /** Automated tests create many accounts from one address; never honoured in production. */
  disableRateLimit: !isProd && process.env.DISABLE_RATE_LIMIT === 'true',

  /** Transactional email via Resend. Without it, emails are printed to the server log (dev only). */
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM ?? 'DocCompare <no-reply@example.com>',

  stripe: process.env.STRIPE_SECRET_KEY
    ? {
        /** Prefer a restricted key (rk_…) with only the permissions listed in .env.example. */
        secretKey: process.env.STRIPE_SECRET_KEY,
        webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
        /** Per-seat recurring prices. */
        monthlyPriceId: required('STRIPE_PRICE_MONTHLY'),
        annualPriceId: process.env.STRIPE_PRICE_ANNUAL,
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

if (isProd && !env.resendApiKey) throw new Error('RESEND_API_KEY is required in production to send sign-in and invitation emails.');
if (isProd && !env.stripe && process.env.BILLING_DISABLED !== 'true')
  throw new Error('Stripe is not configured. Set STRIPE_* variables, or BILLING_DISABLED=true to run without billing.');
