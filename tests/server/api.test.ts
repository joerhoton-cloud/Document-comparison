import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs against a real Postgres database (see vitest.server.config.ts).
const { createApp } = await import('../../server/app');
const { migrate } = await import('../../server/migrate');
const { db } = await import('../../server/db');
const { devOutbox } = await import('../../server/mailer');
const { sql } = await import('kysely');

const BASE = process.env.BASE_URL!;
const app = createApp('dist');
let ipCounter = 1;

/** A browser-like client: keeps cookies and sends the app's Origin. */
class Client {
  cookies = new Map<string, string>();
  ip = `10.0.0.${ipCounter++}`;

  async fetch(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    headers.set('origin', BASE);
    headers.set('x-forwarded-for', this.ip);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await app.fetch(new Request(BASE + path, { ...init, headers, body, redirect: 'manual' }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return res;
  }

  async json<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

function lastLinkTo(email: string): string {
  const mail = [...devOutbox].reverse().find((m) => m.to === email);
  if (!mail?.action) throw new Error(`No email with a link was sent to ${email}`);
  return mail.action.url.replace(BASE, '');
}

async function signUpVerified(email: string, name: string): Promise<Client> {
  const c = new Client();
  const res = await c.json('/api/auth/sign-up/email', { method: 'POST', json: { email, name, password: 'correct-horse-battery-staple' } });
  expect(res.status).toBe(200);
  // Following the confirmation link signs the user in.
  const verify = await c.fetch(lastLinkTo(email));
  expect([200, 302]).toContain(verify.status);
  return c;
}

async function createWorkspace(c: Client, name: string) {
  const res = await c.json('/api/auth/organization/create', {
    method: 'POST',
    json: { name, slug: name.toLowerCase().replace(/\W+/g, '-') + '-' + Date.now() },
  });
  expect(res.status).toBe(200);
  await c.json('/api/auth/organization/set-active', { method: 'POST', json: { organizationId: res.body.id } });
  return res.body.id as string;
}

const hash = (ch: string) => ch.repeat(64);
const newComparison = (overrides: Record<string, unknown> = {}) => ({
  left: { name: 'contract-v1.pdf', sha256: hash('a'), size: 2738, format: 'pdf' },
  right: { name: 'contract-v2.docx', sha256: hash('b'), size: 37414, format: 'docx' },
  options: { ignoreCase: false, ignorePunctuation: false, ignoreWhitespace: true, granularity: 'word' },
  stats: { total: 14, inserted: 3, deleted: 1, replaced: 10, similarity: 0.874 },
  saveLevel: 'progress',
  ...overrides,
});

let owner: Client;
let teammate: Client;
let outsider: Client;
let comparisonId: string;

beforeAll(async () => {
  await migrate();
  await sql`TRUNCATE "user", "organization" CASCADE`.execute(db);
  owner = await signUpVerified('owner@acme.test', 'Olivia Owner');
  await createWorkspace(owner, 'Acme');
  teammate = await signUpVerified('teammate@acme.test', 'Tom Teammate');
  outsider = await signUpVerified('someone@other.test', 'Sam Outsider');
  await createWorkspace(outsider, 'Other Co');
});

afterAll(async () => {
  await db.destroy();
});

describe('authentication', () => {
  it('rejects API calls without a session', async () => {
    const res = await new Client().json('/api/me');
    expect(res.status).toBe(401);
  });

  it('requires a verified email to sign in with a password', async () => {
    const c = new Client();
    await c.json('/api/auth/sign-up/email', { method: 'POST', json: { email: 'unverified@acme.test', name: 'U', password: 'correct-horse-battery-staple' } });
    const res = await c.json('/api/auth/sign-in/email', { method: 'POST', json: { email: 'unverified@acme.test', password: 'correct-horse-battery-staple' } });
    expect(res.status).toBe(403);
  });

  it('rejects short passwords', async () => {
    const res = await new Client().json('/api/auth/sign-up/email', { method: 'POST', json: { email: 'short@acme.test', name: 'S', password: 'short' } });
    expect(res.status).toBe(400);
  });

  it('reports the workspace and role', async () => {
    const res = await owner.json('/api/me');
    expect(res.body.user.email).toBe('owner@acme.test');
    expect(res.body.workspace).toMatchObject({ name: 'Acme', role: 'owner', members: 1 });
  });

  it('blocks workspace APIs for users without a workspace', async () => {
    const res = await teammate.json('/api/comparisons');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_workspace');
  });

  it('rejects cross-site requests (CSRF)', async () => {
    const res = await app.fetch(
      new Request(BASE + '/api/comparisons', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json', cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: JSON.stringify(newComparison()),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('team workspace', () => {
  it('lets the owner invite a teammate who then joins', async () => {
    const me = await owner.json('/api/me');
    const inv = await owner.json('/api/auth/organization/invite-member', {
      method: 'POST',
      json: { email: 'teammate@acme.test', role: 'member', organizationId: me.body.workspace.id },
    });
    expect(inv.status).toBe(200);
    const invitationId = new URL(BASE + lastLinkTo('teammate@acme.test')).searchParams.get('invitation');
    const accept = await teammate.json('/api/auth/organization/accept-invitation', { method: 'POST', json: { invitationId } });
    expect(accept.status).toBe(200);
    await teammate.json('/api/auth/organization/set-active', { method: 'POST', json: { organizationId: me.body.workspace.id } });
    const tm = await teammate.json('/api/me');
    expect(tm.body.workspace).toMatchObject({ name: 'Acme', role: 'member', members: 2 });
  });
});

describe('saved comparisons', () => {
  it('validates input', async () => {
    const res = await owner.json('/api/comparisons', { method: 'POST', json: newComparison({ left: { name: 'x', sha256: 'nope', size: 1, format: 'pdf' } }) });
    expect(res.status).toBe(400);
  });

  it('saves metadata and fingerprints only', async () => {
    const res = await owner.json('/api/comparisons', { method: 'POST', json: newComparison() });
    expect(res.status).toBe(201);
    comparisonId = res.body.comparison.id;
    expect(res.body.comparison).toMatchObject({ left_name: 'contract-v1.pdf', created_by_name: 'Olivia Owner', save_level: 'progress', reviewed_count: 0 });
  });

  it('finds an earlier comparison of the same files, in either order', async () => {
    for (const [l, r] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      const res = await teammate.json(`/api/comparisons/lookup?left=${hash(l)}&right=${hash(r)}`);
      expect(res.body.matches.map((m: any) => m.id)).toEqual([comparisonId]);
    }
    const none = await teammate.json(`/api/comparisons/lookup?left=${hash('a')}&right=${hash('c')}`);
    expect(none.body.matches).toEqual([]);
  });

  it('never exposes one workspace’s comparisons to another', async () => {
    expect((await outsider.json(`/api/comparisons/lookup?left=${hash('a')}&right=${hash('b')}`)).body.matches).toEqual([]);
    expect((await outsider.json(`/api/comparisons/${comparisonId}`)).status).toBe(404);
    expect((await outsider.json('/api/comparisons')).body.comparisons).toEqual([]);
    const review = await outsider.json(`/api/comparisons/${comparisonId}/reviews/0-deadbeef`, { method: 'PUT', json: { status: 'reviewed' } });
    expect(review.status).toBe(404);
    expect((await outsider.json(`/api/comparisons/${comparisonId}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('shares review progress between teammates', async () => {
    expect((await owner.json(`/api/comparisons/${comparisonId}/reviews/0-0a1b2c3d`, { method: 'PUT', json: { status: 'reviewed' } })).status).toBe(200);
    expect(
      (await teammate.json(`/api/comparisons/${comparisonId}/reviews/1-11223344`, { method: 'PUT', json: { status: 'flagged', note: 'Ask legal about the new fee' } })).status,
    ).toBe(200);
    const res = await teammate.json(`/api/comparisons/${comparisonId}`);
    expect(res.body.comparison).toMatchObject({ reviewed_count: 1, flagged_count: 1 });
    expect(res.body.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ change_key: '0-0a1b2c3d', status: 'reviewed', updated_by_name: 'Olivia Owner' }),
        expect.objectContaining({ change_key: '1-11223344', status: 'flagged', note: 'Ask legal about the new fee', updated_by_name: 'Tom Teammate' }),
      ]),
    );
  });

  it('clears a review mark', async () => {
    await owner.json(`/api/comparisons/${comparisonId}/reviews/0-0a1b2c3d`, { method: 'PUT', json: { status: null, note: null } });
    const res = await owner.json(`/api/comparisons/${comparisonId}`);
    expect(res.body.comparison.reviewed_count).toBe(0);
  });

  it('refuses review marks when only activity is being logged', async () => {
    const created = await owner.json('/api/comparisons', { method: 'POST', json: newComparison({ saveLevel: 'activity' }) });
    const res = await owner.json(`/api/comparisons/${created.body.comparison.id}/reviews/0-0a1b2c3d`, { method: 'PUT', json: { status: 'reviewed' } });
    expect(res.status).toBe(409);
  });

  it('records a team activity history', async () => {
    await teammate.json(`/api/comparisons/${comparisonId}/open`, { method: 'POST' });
    const res = await owner.json('/api/activity');
    const actions = res.body.activity.map((a: any) => `${a.user_name}:${a.action}`);
    expect(actions).toEqual(expect.arrayContaining(['Olivia Owner:created', 'Tom Teammate:opened', 'Tom Teammate:flagged', 'Olivia Owner:reviewed']));
  });

  it('only lets the creator or an admin delete', async () => {
    expect((await teammate.json(`/api/comparisons/${comparisonId}`, { method: 'DELETE' })).status).toBe(403);
    expect((await owner.json(`/api/comparisons/${comparisonId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await owner.json(`/api/comparisons/${comparisonId}`)).status).toBe(404);
    const reviews = await db.selectFrom('review').selectAll().where('comparison_id', '=', comparisonId).execute();
    expect(reviews).toEqual([]);
  });
});
