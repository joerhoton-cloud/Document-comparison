import { randomUUID } from 'node:crypto';
import { Hono, type Context, type Next } from 'hono';
import { sql } from 'kysely';
import { z } from 'zod';
import { ADMIN_ROLES, auth, BILLING_ENABLED } from './auth';
import { db } from './db';

/*
 * Workspace API. Everything here is scoped to the signed-in user's active workspace.
 * Documents never reach this server: a saved comparison is metadata (file names,
 * sizes, SHA-256 fingerprints, counts) plus the team's review marks and notes.
 */

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
type Vars = { session: Session; orgId: string; role: string };
type Ctx = Context<{ Variables: Vars }>;

const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export async function subscriptionFor(orgId: string) {
  if (!BILLING_ENABLED) return null;
  return db
    .selectFrom('subscription')
    .select(['status', 'plan', 'seats', 'periodEnd', 'trialEnd', 'cancelAtPeriodEnd'])
    .where('referenceId', '=', orgId)
    .orderBy(sql`CASE WHEN status IN ('active','trialing','past_due') THEN 0 ELSE 1 END`)
    .executeTakeFirst();
}

async function requireSession(c: Ctx, next: Next) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'not_signed_in', message: 'Sign in to continue.' }, 401);
  c.set('session', session);
  await next();
  return undefined;
}

/** Signed in, member of a workspace, and the workspace has a current subscription. */
async function requireWorkspace(c: Ctx, next: Next) {
  const session = c.get('session');
  const orgId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!orgId) return c.json({ error: 'no_workspace', message: 'Create or join a workspace first.' }, 403);
  const member = await db
    .selectFrom('member')
    .select('role')
    .where('organizationId', '=', orgId)
    .where('userId', '=', session.user.id)
    .executeTakeFirst();
  if (!member) return c.json({ error: 'no_workspace', message: 'You are no longer a member of this workspace.' }, 403);
  if (BILLING_ENABLED) {
    const sub = await subscriptionFor(orgId);
    if (!sub || !ACTIVE_STATUSES.has(sub.status ?? ''))
      return c.json({ error: 'subscription_required', message: 'This workspace needs an active subscription.' }, 402);
  }
  c.set('orgId', orgId);
  c.set('role', member.role);
  await next();
  return undefined;
}

const isAdmin = (role: string) => role.split(',').some((r) => ADMIN_ROLES.has(r.trim()));

const fileSchema = z.object({
  name: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().max(10 * 1024 * 1024 * 1024),
  format: z.enum(['pdf', 'docx', 'text', 'html']),
});
const optionsSchema = z.object({
  ignoreCase: z.boolean(),
  ignorePunctuation: z.boolean(),
  ignoreWhitespace: z.boolean(),
  granularity: z.enum(['word', 'char']),
});
const statsSchema = z.object({
  total: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
  similarity: z.number().min(0).max(1),
});
const createSchema = z.object({
  left: fileSchema,
  right: fileSchema,
  options: optionsSchema,
  stats: statsSchema,
  saveLevel: z.enum(['activity', 'progress']),
});
const reviewSchema = z.object({
  status: z.enum(['reviewed', 'flagged']).nullable(),
  note: z.string().max(4000).nullable().optional(),
});
const changeKeySchema = z.string().regex(/^[0-9]{1,6}-[0-9a-f]{8}$/);

async function log(orgId: string, userId: string, action: string, comparisonId: string | null, detail: object = {}) {
  await db
    .insertInto('activity')
    .values({ organization_id: orgId, user_id: userId, action, comparison_id: comparisonId, detail: JSON.stringify(detail) })
    .execute();
}

/** Comparison row plus creator and review progress, as returned to the client. */
function comparisonQuery(orgId: string) {
  return db
    .selectFrom('comparison as c')
    .innerJoin('user as u', 'u.id', 'c.created_by')
    .select([
      'c.id',
      'c.created_at',
      'c.updated_at',
      'c.save_level',
      'c.left_name',
      'c.left_sha256',
      'c.left_size',
      'c.left_format',
      'c.right_name',
      'c.right_sha256',
      'c.right_size',
      'c.right_format',
      'c.options',
      'c.stats',
      'c.created_by',
      'u.name as created_by_name',
      'u.email as created_by_email',
      sql<number>`(SELECT count(*) FROM review r WHERE r.comparison_id = c.id AND r.status = 'reviewed')::int`.as('reviewed_count'),
      sql<number>`(SELECT count(*) FROM review r WHERE r.comparison_id = c.id AND r.status = 'flagged')::int`.as('flagged_count'),
      sql<Date | null>`(SELECT max(r.updated_at) FROM review r WHERE r.comparison_id = c.id)`.as('last_review_at'),
    ])
    .where('c.organization_id', '=', orgId);
}

export const api = new Hono<{ Variables: Vars }>();

api.use('*', requireSession);

/** Who am I, which workspace, and billing state. Available without a subscription. */
api.get('/me', async (c) => {
  const { user, session } = c.get('session');
  const orgId = (session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  let workspace = null;
  if (orgId) {
    const row = await db
      .selectFrom('member as m')
      .innerJoin('organization as o', 'o.id', 'm.organizationId')
      .select(['o.id as id', 'o.name as name', 'm.role as role'])
      .where('m.organizationId', '=', orgId)
      .where('m.userId', '=', user.id)
      .executeTakeFirst();
    if (row) {
      const members = await db
        .selectFrom('member')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('organizationId', '=', orgId)
        .executeTakeFirstOrThrow();
      const sub = await subscriptionFor(orgId);
      workspace = { ...row, members: members.n, subscription: sub ?? null };
    }
  }
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, twoFactorEnabled: !!(user as { twoFactorEnabled?: boolean }).twoFactorEnabled },
    workspace,
    billingEnabled: BILLING_ENABLED,
  });
});

const ws = new Hono<{ Variables: Vars }>();
ws.use('*', requireWorkspace);

ws.get('/comparisons', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
  const before = c.req.query('before');
  let q = comparisonQuery(c.get('orgId')).orderBy('c.created_at', 'desc').limit(limit);
  if (before) q = q.where('c.created_at', '<', new Date(before));
  return c.json({ comparisons: await q.execute() });
});

/** Has anyone in the workspace already compared these two files (in either order)? */
ws.get('/comparisons/lookup', async (c) => {
  const left = c.req.query('left') ?? '';
  const right = c.req.query('right') ?? '';
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return c.json({ error: 'bad_request' }, 400);
  const matches = await comparisonQuery(c.get('orgId'))
    .where((eb) =>
      eb.or([
        eb.and([eb('c.left_sha256', '=', left), eb('c.right_sha256', '=', right)]),
        eb.and([eb('c.left_sha256', '=', right), eb('c.right_sha256', '=', left)]),
      ]),
    )
    .orderBy('c.created_at', 'desc')
    .limit(10)
    .execute();
  return c.json({ matches });
});

ws.post('/comparisons', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400);
  const { left, right, options, stats, saveLevel } = parsed.data;
  const id = randomUUID();
  const userId = c.get('session').user.id;
  await db
    .insertInto('comparison')
    .values({
      id,
      organization_id: c.get('orgId'),
      created_by: userId,
      save_level: saveLevel,
      left_name: left.name,
      left_sha256: left.sha256,
      left_size: left.size,
      left_format: left.format,
      right_name: right.name,
      right_sha256: right.sha256,
      right_size: right.size,
      right_format: right.format,
      options: JSON.stringify(options),
      stats: JSON.stringify(stats),
    })
    .execute();
  await log(c.get('orgId'), userId, 'created', id, { saveLevel, total: stats.total });
  const row = await comparisonQuery(c.get('orgId')).where('c.id', '=', id).executeTakeFirstOrThrow();
  return c.json({ comparison: row }, 201);
});

ws.get('/comparisons/:id', async (c) => {
  const row = await comparisonQuery(c.get('orgId')).where('c.id', '=', c.req.param('id')).executeTakeFirst();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const reviews = await db
    .selectFrom('review as r')
    .innerJoin('user as u', 'u.id', 'r.updated_by')
    .select(['r.change_key', 'r.status', 'r.note', 'r.updated_at', 'u.name as updated_by_name'])
    .where('r.comparison_id', '=', row.id)
    .execute();
  const history = await db
    .selectFrom('activity as a')
    .innerJoin('user as u', 'u.id', 'a.user_id')
    .select(['a.action', 'a.detail', 'a.created_at', 'u.name as user_name'])
    .where('a.comparison_id', '=', row.id)
    .orderBy('a.created_at', 'desc')
    .limit(100)
    .execute();
  return c.json({ comparison: row, reviews, history });
});

/** Record that someone reopened a saved comparison (shows in the team history). */
ws.post('/comparisons/:id/open', async (c) => {
  const row = await comparisonQuery(c.get('orgId')).where('c.id', '=', c.req.param('id')).executeTakeFirst();
  if (!row) return c.json({ error: 'not_found' }, 404);
  await log(c.get('orgId'), c.get('session').user.id, 'opened', row.id);
  return c.json({ ok: true });
});

ws.patch('/comparisons/:id', async (c) => {
  const body = z.object({ saveLevel: z.enum(['activity', 'progress']) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'bad_request' }, 400);
  const id = c.req.param('id');
  const res = await db
    .updateTable('comparison')
    .set({ save_level: body.data.saveLevel, updated_at: new Date() })
    .where('id', '=', id)
    .where('organization_id', '=', c.get('orgId'))
    .executeTakeFirst();
  if (!res.numUpdatedRows) return c.json({ error: 'not_found' }, 404);
  // Downgrading to "activity only" discards review marks and notes.
  if (body.data.saveLevel === 'activity') await db.deleteFrom('review').where('comparison_id', '=', id).execute();
  await log(c.get('orgId'), c.get('session').user.id, 'save_level', id, { saveLevel: body.data.saveLevel });
  return c.json({ ok: true });
});

ws.put('/comparisons/:id/reviews/:key', async (c) => {
  const key = c.req.param('key');
  if (!changeKeySchema.safeParse(key).success) return c.json({ error: 'bad_request' }, 400);
  const body = reviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'bad_request', issues: body.error.issues }, 400);
  const cmp = await db
    .selectFrom('comparison')
    .select(['id', 'save_level'])
    .where('id', '=', c.req.param('id'))
    .where('organization_id', '=', c.get('orgId'))
    .executeTakeFirst();
  if (!cmp) return c.json({ error: 'not_found' }, 404);
  if (cmp.save_level !== 'progress')
    return c.json({ error: 'not_saving_progress', message: 'Turn on "Save review progress" for this comparison first.' }, 409);

  const userId = c.get('session').user.id;
  const note = body.data.note?.trim() || null;
  if (!body.data.status && !note) {
    await db.deleteFrom('review').where('comparison_id', '=', cmp.id).where('change_key', '=', key).execute();
  } else {
    await db
      .insertInto('review')
      .values({ comparison_id: cmp.id, change_key: key, status: body.data.status ?? 'reviewed', note, updated_by: userId })
      .onConflict((oc) =>
        oc.columns(['comparison_id', 'change_key']).doUpdateSet({
          status: body.data.status ?? 'reviewed',
          note,
          updated_by: userId,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
  await db.updateTable('comparison').set({ updated_at: new Date() }).where('id', '=', cmp.id).execute();
  await log(c.get('orgId'), userId, body.data.status ?? 'cleared', cmp.id, { note: !!note });
  return c.json({ ok: true });
});

ws.delete('/comparisons/:id', async (c) => {
  const row = await db
    .selectFrom('comparison')
    .select(['id', 'created_by', 'left_name', 'right_name'])
    .where('id', '=', c.req.param('id'))
    .where('organization_id', '=', c.get('orgId'))
    .executeTakeFirst();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const userId = c.get('session').user.id;
  if (row.created_by !== userId && !isAdmin(c.get('role')))
    return c.json({ error: 'forbidden', message: 'Only the person who saved it or a workspace admin can delete it.' }, 403);
  await db.deleteFrom('comparison').where('id', '=', row.id).execute();
  await log(c.get('orgId'), userId, 'deleted', null, { left: row.left_name, right: row.right_name });
  return c.json({ ok: true });
});

/** Workspace activity feed: who compared, reopened, reviewed or deleted what. */
ws.get('/activity', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
  const rows = await db
    .selectFrom('activity as a')
    .innerJoin('user as u', 'u.id', 'a.user_id')
    .leftJoin('comparison as c', 'c.id', 'a.comparison_id')
    .select([
      'a.id',
      'a.action',
      'a.detail',
      'a.created_at',
      'a.comparison_id',
      'u.name as user_name',
      'c.left_name',
      'c.right_name',
    ])
    .where('a.organization_id', '=', c.get('orgId'))
    .orderBy('a.created_at', 'desc')
    .limit(limit)
    .execute();
  return c.json({ activity: rows });
});

api.route('/', ws);
