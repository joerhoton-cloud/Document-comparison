import { stripeClient } from './auth';
import { env } from './env';

export interface PublicPrice {
  plan: string;
  interval: string;
  /** Minor units (cents) per seat. */
  amount: number;
  currency: string;
}

let cache: { at: number; prices: PublicPrice[] } | undefined;

/** Seat prices shown on the plan screen, read from Stripe and cached for 10 minutes. */
async function prices(): Promise<PublicPrice[]> {
  if (!env.stripe) return [];
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.prices;
  const stripe = stripeClient();
  const ids: [string, string | undefined][] = [
    ['team', env.stripe.monthlyPriceId],
    ['team-annual', env.stripe.annualPriceId],
  ];
  const out: PublicPrice[] = [];
  for (const [plan, id] of ids) {
    if (!id) continue;
    try {
      const p = await stripe.prices.retrieve(id);
      out.push({ plan, interval: p.recurring?.interval ?? 'month', amount: p.unit_amount ?? 0, currency: p.currency });
    } catch {
      // Unknown price or Stripe unreachable: the plan screen shows the plan without an amount.
      out.push({ plan, interval: plan === 'team-annual' ? 'year' : 'month', amount: 0, currency: 'usd' });
    }
  }
  cache = { at: Date.now(), prices: out };
  return out;
}

/** Public, unauthenticated app configuration for the sign-in and plan screens. */
export async function publicConfig() {
  return {
    appName: env.appName,
    providers: [env.microsoft && 'microsoft', env.google && 'google'].filter(Boolean) as string[],
    billingEnabled: !!env.stripe,
    trialDays: env.stripe?.trialDays ?? 0,
    prices: await prices(),
  };
}
