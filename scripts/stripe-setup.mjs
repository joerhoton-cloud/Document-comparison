#!/usr/bin/env node
// Creates (or updates) everything DocCompare needs in a Stripe account:
// the "DocCompare Team" product, per-seat monthly/yearly prices, the customer
// portal configuration and, for a public BASE_URL, the webhook endpoint.
// Safe to re-run: existing objects are found by lookup key / metadata and reused.
//
// Usage (use a sandbox key first):
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs --monthly 49 --annual 490 [--currency usd]
//   BASE_URL=https://compare.example.com STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs --monthly 49
import Stripe from 'stripe';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const key = process.env.STRIPE_SECRET_KEY;
if (!key) exit('Set STRIPE_SECRET_KEY (a sandbox key while testing).');
if (/^[sr]k_live_/.test(key) && args.live !== 'yes') exit('Refusing to run against live mode without --live yes.');
const monthly = Number(args.monthly);
const annual = args.annual ? Number(args.annual) : undefined;
const currency = (args.currency ?? 'usd').toLowerCase();
if (!(monthly > 0)) exit('Pass the monthly price per seat, e.g. --monthly 49 (and optionally --annual 490).');

// STRIPE_API_BASE lets tests point at stripe-mock (e.g. http://localhost:12111).
const apiBase = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : undefined;
const stripe = new Stripe(key, apiBase && { host: apiBase.hostname, port: Number(apiBase.port), protocol: apiBase.protocol.replace(':', '') });
const APP = 'doccompare';
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

// ---- product (one product; monthly and yearly are billing variants of the same plan)
let product = (await stripe.products.search({ query: `metadata['app']:'${APP}' AND active:'true'` })).data[0];
if (!product) {
  product = await stripe.products.create({
    name: 'DocCompare Team',
    description: 'Private side-by-side document comparison with shared team review. Billed per member.',
    metadata: { app: APP },
    unit_label: 'seat',
  });
  log(`Created product ${product.id}`);
} else log(`Using product ${product.id}`);

// ---- prices, found by lookup key; a changed amount creates a new price and moves the key to it
async function seatPrice(lookupKey, amount, interval) {
  const unit = Math.round(amount * 100);
  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], expand: ['data.product'] })).data[0];
  if (existing && existing.unit_amount === unit && existing.currency === currency && existing.recurring?.interval === interval) {
    log(`Using ${interval}ly price ${existing.id} (${fmt(unit)}/seat)`);
    return existing;
  }
  const price = await stripe.prices.create({
    product: product.id,
    currency,
    unit_amount: unit,
    recurring: { interval, usage_type: 'licensed' },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    tax_behavior: 'exclusive',
    nickname: `Team seat, ${interval}ly`,
  });
  log(`Created ${interval}ly price ${price.id} (${fmt(unit)}/seat)`);
  return price;
}
const monthlyPrice = await seatPrice(`${APP}_team_seat_monthly`, monthly, 'month');
const annualPrice = annual ? await seatPrice(`${APP}_team_seat_yearly`, annual, 'year') : undefined;
if (!product.default_price) await stripe.products.update(product.id, { default_price: monthlyPrice.id });

// ---- customer portal: update card, see invoices, update billing details, cancel at period end
const portalFeatures = {
  payment_method_update: { enabled: true },
  invoice_history: { enabled: true },
  customer_update: { enabled: true, allowed_updates: ['email', 'address', 'name', 'tax_id'] },
  subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'unused', 'other'] } },
};
const portals = (await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 })).data;
if (portals[0]) {
  await stripe.billingPortal.configurations.update(portals[0].id, { features: portalFeatures });
  log(`Updated customer portal ${portals[0].id}`);
} else {
  const p = await stripe.billingPortal.configurations.create({
    features: portalFeatures,
    business_profile: { headline: 'Manage your DocCompare subscription' },
  });
  log(`Created customer portal ${p.id}`);
}

// ---- webhook endpoint (only for a public HTTPS URL; locally use `stripe listen`)
let webhookSecret;
const base = process.env.BASE_URL?.replace(/\/$/, '');
if (base?.startsWith('https://')) {
  const url = `${base}/api/auth/stripe/webhook`;
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS });
    log(`Updated webhook ${existing.id} (its signing secret is unchanged; find it in the Dashboard)`);
  } else {
    const w = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, description: 'DocCompare subscriptions' });
    webhookSecret = w.secret;
    log(`Created webhook ${w.id} → ${url}`);
  }
} else {
  log('Skipped webhook endpoint (BASE_URL is not a public https URL). For local testing run:');
  log(`  stripe listen --forward-to localhost:3000/api/auth/stripe/webhook --events ${WEBHOOK_EVENTS.join(',')}`);
}

console.log('\nAdd these to your environment (secrets store in production):\n');
console.log(`STRIPE_PRICE_MONTHLY=${monthlyPrice.id}`);
if (annualPrice) console.log(`STRIPE_PRICE_ANNUAL=${annualPrice.id}`);
if (webhookSecret) console.log(`STRIPE_WEBHOOK_SECRET=${webhookSecret}   # shown once; store it now`);

function fmt(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
function log(m) {
  console.log(`[stripe-setup] ${m}`);
}
function exit(m) {
  console.error(`[stripe-setup] ${m}`);
  process.exit(1);
}
