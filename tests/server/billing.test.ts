import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Billing on, with fake Stripe credentials (no network calls are made in these tests).
Object.assign(process.env, {
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  STRIPE_PRICE_TEAM: 'price_team',
  STRIPE_PRICE_UNLIMITED: 'price_unlimited',
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

it('emails workspace owners and admins when a renewal payment fails', async () => {
  const { onStripeEvent } = await import('../../server/billingEvents');
  await sql`UPDATE subscription SET "stripeSubscriptionId" = 'sub_live_123' WHERE id = 'sub_trialing'`.execute(db);
  const before = devOutbox.length;
  await onStripeEvent({
    type: 'invoice.payment_failed',
    data: {
      object: {
        object: 'invoice',
        currency: 'usd',
        amount_due: 15600,
        next_payment_attempt: 1_800_000_000,
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_live_123' } },
      },
    },
  } as never);
  const sent = devOutbox.slice(before);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: 'payer@acme.test', subject: 'Payment failed for Acme on DocCompare' });
  expect(sent[0].text).toContain('$156.00');
  expect(sent[0].action?.url).toBe('http://localhost:3000/?page=team');
});

it('ignores failed invoices for subscriptions it does not know', async () => {
  const { onStripeEvent } = await import('../../server/billingEvents');
  const before = devOutbox.length;
  await onStripeEvent({
    type: 'invoice.payment_failed',
    data: { object: { currency: 'usd', amount_due: 100, parent: { subscription_details: { subscription: 'sub_unknown' } } } },
  } as never);
  expect(devOutbox.length).toBe(before);
});

describe('plan member limits', () => {
  const invite = (email: string) =>
    call('/api/auth/organization/invite-member', { method: 'POST', json: { email, role: 'member', organizationId: orgId } });

  it('allows 5 members on Team, counting pending invitations', async () => {
    // Pat (the owner) is member 1 on a trialing Team plan; four more invitations fill the plan.
    for (let i = 1; i <= 4; i++) expect((await invite(`colleague${i}@acme.test`)).status).toBe(200);
    const sixth = await invite('colleague5@acme.test');
    expect(sixth.status).toBe(403);
    const me = await (await call('/api/me')).json();
    expect(me.workspace.memberLimit).toBe(5);
  });

  it('refuses to accept an invitation once the workspace is full', async () => {
    // Four extra members join directly, so the workspace is at 5.
    for (let i = 1; i <= 4; i++) {
      await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (${'u' + i}, ${'User ' + i}, ${'u' + i + '@acme.test'}, true, now(), now())`.execute(db);
      await sql`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (${'m' + i}, ${orgId}, ${'u' + i}, 'member', now())`.execute(db);
    }
    await sql`UPDATE invitation SET status = 'canceled' WHERE "organizationId" = ${orgId}`.execute(db);
    expect((await invite('late@acme.test')).status).toBe(403);
  });

  it('lifts the limit on Unlimited', async () => {
    await sql`UPDATE subscription SET plan = 'unlimited' WHERE id = 'sub_trialing'`.execute(db);
    expect((await invite('sixth@acme.test')).status).toBe(200);
    const me = await (await call('/api/me')).json();
    expect(me.workspace.memberLimit).toBeNull();
  });

  it('blocks switching to Team while the workspace has more than 5 members', async () => {
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u5', 'User 5', 'u5@acme.test', true, now(), now())`.execute(db);
    await sql`INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m5', ${orgId}, 'u5', 'member', now())`.execute(db);
    const res = await call('/api/auth/subscription/upgrade', { method: 'POST', json: { plan: 'team', customerType: 'organization', referenceId: orgId } });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain('Remove 1 member first');
  });
});
