import { afterAll, beforeAll, expect, it } from 'vitest';

// Billing on, with fake Stripe credentials (no network calls are made in these tests).
Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  STRIPE_PRICE_MONTHLY: 'price_seat_monthly',
});

const { createApp } = await import('../../server/app');
const { migrate } = await import('../../server/migrate');
const { db } = await import('../../server/db');
const { devOutbox } = await import('../../server/mailer');
const { sql } = await import('kysely');

const BASE = process.env.BASE_URL!;
const app = createApp('dist');
const cookies = new Map<string, string>();

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers({ origin: BASE, 'x-forwarded-for': '10.9.9.9' });
  if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await app.fetch(
    new Request(BASE + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: 'manual' }),
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
  await migrate();
  await sql`TRUNCATE "user", "organization", subscription CASCADE`.execute(db);
  await call('/api/auth/sign-up/email', { method: 'POST', json: { email: 'payer@acme.test', name: 'Pat', password: 'correct-horse-battery-staple' } });
  const link = [...devOutbox].reverse().find((m) => m.to === 'payer@acme.test')!.action!.url.replace(BASE, '');
  await call(link);
  const org = await (await call('/api/auth/organization/create', { method: 'POST', json: { name: 'Acme', slug: `acme-${Date.now()}` } })).json();
  orgId = org.id;
  await call('/api/auth/organization/set-active', { method: 'POST', json: { organizationId: orgId } });
});

afterAll(async () => {
  await db.destroy();
});

const setStatus = (status: string) =>
  sql`INSERT INTO subscription (id, plan, "referenceId", status, seats) VALUES (${'sub_' + status}, 'team', ${orgId}, ${status}, 1)`.execute(db);

it('locks the workspace until it has a subscription', async () => {
  const res = await call('/api/comparisons');
  expect(res.status).toBe(402);
  const me = await (await call('/api/me')).json();
  expect(me).toMatchObject({ billingEnabled: true, workspace: { subscription: null } });
});

it('treats canceled subscriptions as inactive', async () => {
  await setStatus('canceled');
  expect((await call('/api/comparisons')).status).toBe(402);
});

it('opens the workspace during a trial', async () => {
  await setStatus('trialing');
  expect((await call('/api/comparisons')).status).toBe(200);
  const me = await (await call('/api/me')).json();
  expect(me.workspace.subscription.status).toBe('trialing');
});
