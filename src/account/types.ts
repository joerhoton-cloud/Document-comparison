import type { CompareOptions, CompareStats, ExtractedDoc } from '../types';

export interface PublicConfig {
  appName: string;
  providers: string[];
  billingEnabled: boolean;
  trialDays: number;
  prices: { plan: string; label: string; maxMembers: number | null; interval: string; amount: number; currency: string }[];
}

export interface Subscription {
  status: string | null;
  plan: string;
  seats: number | null;
  periodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
}

export interface Me {
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean };
  workspace: { id: string; name: string; role: string; members: number; memberLimit: number | null; subscription: Subscription | null } | null;
  billingEnabled: boolean;
}

export type SaveLevel = 'none' | 'activity' | 'progress';

export interface SavedComparison {
  id: string;
  created_at: string;
  updated_at: string;
  save_level: 'activity' | 'progress';
  left_name: string;
  left_sha256: string;
  left_size: number;
  left_format: ExtractedDoc['format'];
  right_name: string;
  right_sha256: string;
  right_size: number;
  right_format: ExtractedDoc['format'];
  options: CompareOptions;
  stats: Pick<CompareStats, 'total' | 'inserted' | 'deleted' | 'replaced' | 'similarity'>;
  created_by: string;
  created_by_name: string;
  created_by_email: string;
  reviewed_count: number;
  flagged_count: number;
  last_review_at: string | null;
}

export interface ReviewMark {
  change_key: string;
  status: 'reviewed' | 'flagged';
  note: string | null;
  updated_at: string;
  updated_by_name: string;
}

export interface ActivityItem {
  id: number;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
  comparison_id: string | null;
  user_name: string;
  left_name: string | null;
  right_name: string | null;
}

export const isAdminRole = (role: string) => role.split(',').some((r) => ['owner', 'admin'].includes(r.trim()));

export function hasActiveSubscription(me: Me): boolean {
  if (!me.billingEnabled) return true;
  const s = me.workspace?.subscription?.status;
  return s === 'active' || s === 'trialing' || s === 'past_due';
}

export const PLAN_LABEL: Record<string, string> = { team: 'Team', unlimited: 'Unlimited' };

/** Start Checkout for a plan, or switch an existing subscription to it. */
export function planPayload(plan: string, workspaceId: string) {
  return {
    plan,
    customerType: 'organization',
    referenceId: workspaceId,
    successUrl: `${location.origin}/?billing=success`,
    cancelUrl: `${location.origin}/?billing=cancelled`,
    returnUrl: `${location.origin}/?page=team`,
    disableRedirect: true,
  };
}
