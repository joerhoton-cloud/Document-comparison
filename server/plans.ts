import { sql } from 'kysely';
import { db } from './db';
import { env } from './env';

/** Subscription plans. Each is a separate Stripe Product with one flat monthly Price. */
export const PLANS = {
  team: { label: 'Team', maxMembers: 5 as number | null },
  unlimited: { label: 'Unlimited', maxMembers: null as number | null },
} as const;
export type PlanName = keyof typeof PLANS;

/** Stand-in for "no limit" where the auth library expects a number. */
const NO_LIMIT = 1_000_000;

async function currentPlan(orgId: string): Promise<PlanName | null> {
  const sub = await db
    .selectFrom('subscription')
    .select('plan')
    .where('referenceId', '=', orgId)
    .where('status', 'in', ['active', 'trialing', 'past_due'])
    .executeTakeFirst();
  return sub && sub.plan in PLANS ? (sub.plan as PlanName) : null;
}

/** Maximum members for a workspace: its plan's limit, the Team limit before subscribing, none without billing. */
export async function memberLimit(orgId: string): Promise<number> {
  if (!env.stripe) return NO_LIMIT;
  const plan = (await currentPlan(orgId)) ?? 'team';
  return PLANS[plan].maxMembers ?? NO_LIMIT;
}

export async function memberCount(orgId: string): Promise<number> {
  const r = await db
    .selectFrom('member')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('organizationId', '=', orgId)
    .executeTakeFirstOrThrow();
  return r.n;
}

/**
 * How many more invitations may be pending: members plus pending invitations
 * never exceed the plan limit, so every invitation sent can be accepted.
 */
export async function invitationLimit(orgId: string): Promise<number> {
  const limit = await memberLimit(orgId);
  if (limit >= NO_LIMIT) return NO_LIMIT;
  return Math.max(0, limit - (await memberCount(orgId)));
}

/** Reason a workspace can't switch to `plan`, or null if it can. */
export async function planChangeBlocker(orgId: string, plan: string): Promise<string | null> {
  const max = PLANS[plan as PlanName]?.maxMembers;
  if (max == null) return null;
  const n = await memberCount(orgId);
  return n > max
    ? `The ${PLANS[plan as PlanName].label} plan allows up to ${max} members and this workspace has ${n}. Remove ${n - max} member${n - max === 1 ? '' : 's'} first.`
    : null;
}

export function isUnlimited(n: number): boolean {
  return n >= NO_LIMIT;
}
