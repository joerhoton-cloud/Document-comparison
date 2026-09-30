#!/usr/bin/env node
// Creates (or updates) everything DocCompare needs in a Stripe account: one
// product per plan (Team: up to 5 members, Unlimited) with a flat monthly price,
// the customer portal configuration and, for a public BASE_URL, the webhook endpoint.
// Safe to re-run: existing objects are found by lookup key / metadata and reused.
//
// Usage (use a sandbox key first):
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs [--team 49] [--unlimited 100] [--currency usd]
//   BASE_URL=https://compare.example.com STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs
import Stripe from 'stripe';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const key = process.env.STRIPE_SECRET_KEY;
if (!key) exit('Set STRIPE_SECRET_KEY (a sandbox key while testing).');
if (/^[sr]k_live_/.test(key) && args.live !== 'yes') exit('Refusing to run against live mode without --live yes.');
const teamAmount = Number(args.team ?? 49);
const unlimitedAmount = Number(args.unlimited ?? 100);
const currency = (args.currency ?? 'usd').toLowerCase();
if (!(teamAmount > 0 && unlimitedAmount > 0)) exit('Prices must be positive, e.g. --team 49 --unlimited 100.');

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

// ---- one product per plan (so invoices and Checkout show the plan name), each with a flat monthly price
async function planProduct(plan, name, description) {
  let product = (await stripe.products.search({ query: `metadata['app']:'${APP}' AND metadata['plan']:'${plan}' AND active:'true'` })).data[0];
  if (!product) {
    product = await stripe.products.create({ name, description, metadata: { app: APP, plan } });
    log(`Created product ${product.id} (${name})`);
  } else log(`Using product ${product.id} (${name})`);
  return product;
}

// Prices are found by lookup key; a changed amount creates a new price and moves the key to it.
async function monthlyPrice(product, lookupKey, amount) {
  const unit = Math.round(amount * 100);
  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey] })).data[0];
  if (existing && existing.unit_amount === unit && existing.currency === currency && existing.recurring?.interval === 'month' && existing.product === product.id) {
    log(`Using price ${existing.id} (${fmt(unit)}/month)`);
    return existing;
  }
  const price = await stripe.prices.create({
    product: product.id,
    currency,
    unit_amount: unit,
    recurring: { interval: 'month', usage_type: 'licensed' },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    tax_behavior: 'exclusive',
    nickname: `${product.name}, monthly`,
  });
  log(`Created price ${price.id} (${fmt(unit)}/month)`);
  if (!product.default_price || product.default_price !== price.id) await stripe.products.update(product.id, { default_price: price.id });
  return price;
}

const teamProduct = await planProduct('team', 'DocCompare Team', 'Private document comparison with shared team review, for up to 5 members.');
const teamPrice = await monthlyPrice(teamProduct, `${APP}_team_monthly`, teamAmount);
const unlimitedProduct = await planProduct('unlimited', 'DocCompare Unlimited', 'Private document comparison with shared team review, for unlimited members.');
const unlimitedPrice = await monthlyPrice(unlimitedProduct, `${APP}_unlimited_monthly`, unlimitedAmount);

// ---- customer portal: update card, see invoices, update billing details, cancel at period end.
// Plan switching stays in the app, which checks member counts before allowing a downgrade.
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
console.log(`STRIPE_PRICE_TEAM=${teamPrice.id}`);
console.log(`STRIPE_PRICE_UNLIMITED=${unlimitedPrice.id}`);
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
