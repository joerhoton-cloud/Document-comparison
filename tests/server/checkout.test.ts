import { afterAll, beforeAll, expect, it } from 'vitest';

// Sends real Checkout / billing-portal requests to stripe-mock, which validates every
// parameter against Stripe's OpenAPI spec. Skipped when stripe-mock isn't running:
//   docker run -p 12111:12111 stripe/stripe-mock
const MOCK = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111';
const mockUp = await fetch(`${MOCK}/v1/products`, { headers: { Authorization: 'Bearer sk_test_123' } })
  .then((r) => r.ok)
  .catch(() => false);

Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_MONTHLY: 'price_seat_monthly',
  STRIPE_PRICE_ANNUAL: 'price_seat_yearly',
  STRIPE_API_BASE: MOCK,
});

const { createApp } = await import('../../server/app');
const { migrate } = await import('../../server/migrate');
const { db } = await import('../../server/db');
const { devOutbox } = await import('../../server/mailer');
const { sql } = await import('kysely');

const BASE = process.env.BASE_URL!;
const app = createApp('dist');
const cookies = new Map<string, string>();

async function call(path: string, json?: unknown) {
  const headers = new Headers({ origin: BASE, 'x-forwarded-for': '10.7.7.7' });
  if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  if (json !== undefined) headers.set('content-type', 'application/json');
  const res = await app.fetch(
    new Request(BASE + path, { method: json === undefined ? 'GET' : 'POST', headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'manual' }),
  );
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (pair.slice(i + 1)) cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

let orgId: string;

beforeAll(async () => {
  if (!mockUp) return;
  await migrate();
  await sql`TRUNCATE "user", "organization", subscription CASCADE`.execute(db);
  await call('/api/auth/sign-up/email', { email: 'buyer@acme.test', name: 'Bea Buyer', password: 'correct-horse-battery-staple' });
  await call([...devOutbox].reverse().find((m) => m.to === 'buyer@acme.test')!.action!.url.replace(BASE, ''));
  orgId = (await (await call('/api/auth/organization/create', { name: 'Acme', slug: `acme-${Date.now()}` })).json()).id;
  await call('/api/auth/organization/set-active', { organizationId: orgId });
});

afterAll(async () => {
  await db.destroy();
});

it.skipIf(!mockUp)('creates a per-seat subscription Checkout Session that Stripe accepts', async () => {
  const res = await call('/api/auth/subscription/upgrade', {
    plan: 'team',
    customerType: 'organization',
    referenceId: orgId,
    seats: 1,
    successUrl: `${BASE}/?billing=success`,
    cancelUrl: `${BASE}/?billing=cancelled`,
    disableRedirect: true,
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
  const sub = await db.selectFrom('subscription').select(['status', 'plan', 'referenceId']).where('referenceId', '=', orgId).executeTakeFirst();
  expect(sub).toMatchObject({ plan: 'team', status: 'incomplete' });
});

it.skipIf(!mockUp)('refuses checkout for members who are not owners or admins', async () => {
  await sql`UPDATE member SET role = 'member' WHERE "organizationId" = ${orgId}`.execute(db);
  const res = await call('/api/auth/subscription/upgrade', { plan: 'team', customerType: 'organization', referenceId: orgId, disableRedirect: true });
  expect(res.status).toBe(401);
  await sql`UPDATE member SET role = 'owner' WHERE "organizationId" = ${orgId}`.execute(db);
});

it.skipIf(!mockUp)('rejects webhooks without a valid Stripe signature', async () => {
  const res = await app.fetch(
    new Request(`${BASE}/api/auth/stripe/webhook`, {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=forged', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'customer.subscription.updated', data: { object: {} } }),
    }),
  );
  expect(res.status).toBe(400);
});
