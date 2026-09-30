import type Stripe from 'stripe';
import { db } from './db';
import { env } from './env';
import { sendEmail } from './mailer';

/**
 * Stripe events beyond the subscription lifecycle that Better Auth's plugin
 * already syncs (checkout.session.completed, customer.subscription.*).
 * Access is always derived from the synced subscription status; these
 * handlers only notify people.
 */
export async function onStripeEvent(event: Stripe.Event): Promise<void> {
  if (event.type === 'invoice.payment_failed') await onPaymentFailed(event.data.object);
}

/** The subscription an invoice belongs to, via Stripe's object graph (not metadata). */
function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === 'string' ? sub : sub.id;
}

/** Workspace owners/admins for the workspace that owns a Stripe subscription. */
async function billingContacts(stripeSubscriptionId: string) {
  const sub = await db
    .selectFrom('subscription')
    .select('referenceId')
    .where('stripeSubscriptionId', '=', stripeSubscriptionId)
    .executeTakeFirst();
  if (!sub) return null;
  const org = await db.selectFrom('organization').select(['id', 'name']).where('id', '=', sub.referenceId).executeTakeFirst();
  if (!org) return null;
  const admins = await db
    .selectFrom('member as m')
    .innerJoin('user as u', 'u.id', 'm.userId')
    .select(['u.email', 'u.name', 'm.role'])
    .where('m.organizationId', '=', org.id)
    .execute();
  return { org, recipients: admins.filter((a) => a.role.split(',').some((r) => ['owner', 'admin'].includes(r.trim()))) };
}

async function onPaymentFailed(invoice: Stripe.Invoice) {
  const subId = subscriptionIdOf(invoice);
  if (!subId) return;
  const target = await billingContacts(subId);
  if (!target) return;
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: invoice.currency }).format(invoice.amount_due / 100);
  const retry = invoice.next_payment_attempt ? new Date(invoice.next_payment_attempt * 1000).toDateString() : null;
  for (const r of target.recipients) {
    await sendEmail({
      to: r.email,
      subject: `Payment failed for ${target.org.name} on ${env.appName}`,
      text:
        `We couldn't collect ${amount} for the ${target.org.name} workspace.` +
        (retry ? ` Stripe will retry on ${retry}.` : '') +
        `\n\nYour team keeps access for now. Update the card on file to avoid interruption.`,
      action: { label: 'Update payment method', url: `${env.baseUrl}/?page=team` },
    });
  }
}
