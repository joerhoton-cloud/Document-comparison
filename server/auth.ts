import { stripe } from '@better-auth/stripe';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { magicLink, organization, twoFactor } from 'better-auth/plugins';
import Stripe from 'stripe';
import { onStripeEvent } from './billingEvents';
import { db, pool } from './db';
import { env } from './env';
import { sendEmail } from './mailer';

export const BILLING_ENABLED = !!env.stripe;

export function stripeClient(): Stripe {
  const base = env.stripe!.apiBase ? new URL(env.stripe!.apiBase) : undefined;
  return new Stripe(
    env.stripe!.secretKey,
    base && { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(':', '') as 'http' | 'https' },
  );
}


/** Roles allowed to manage billing and remove other people's saved comparisons. */
export const ADMIN_ROLES = new Set(['owner', 'admin']);

async function isWorkspaceAdmin(userId: string, organizationId: string): Promise<boolean> {
  const m = await db
    .selectFrom('member')
    .select('role')
    .where('userId', '=', userId)
    .where('organizationId', '=', organizationId)
    .executeTakeFirst();
  return !!m && m.role.split(',').some((r) => ADMIN_ROLES.has(r.trim()));
}

const plugins = [
  organization({
    // One workspace per customer; people join others by invitation.
    allowUserToCreateOrganization: true,
    organizationLimit: 1,
    invitationExpiresIn: 7 * 24 * 60 * 60,
    requireEmailVerificationOnInvitation: true,
    async sendInvitationEmail({ email, organization: org, inviter, id }) {
      await sendEmail({
        to: email,
        subject: `${inviter.user.name} invited you to ${org.name} on ${env.appName}`,
        text: `${inviter.user.name} (${inviter.user.email}) invited you to join the ${org.name} workspace on ${env.appName}, a private document comparison tool.\n\nThe invitation expires in 7 days.`,
        action: { label: 'Accept invitation', url: `${env.baseUrl}/?invitation=${encodeURIComponent(id)}` },
      });
    },
  }),
  magicLink({
    expiresIn: 10 * 60,
    async sendMagicLink({ email, url }) {
      await sendEmail({
        to: email,
        subject: `Sign in to ${env.appName}`,
        text: `Use the link below to sign in. It expires in 10 minutes and works once.\n\nIf you didn't ask for this, ignore this email.`,
        action: { label: `Sign in to ${env.appName}`, url },
      });
    },
  }),
  twoFactor({ issuer: env.appName }),
  ...(env.stripe
    ? [
        stripe({
          stripeClient: stripeClient(),
          stripeWebhookSecret: env.stripe.webhookSecret,
          createCustomerOnSignUp: false,
          // Subscription lifecycle events are synced by the plugin; this adds dunning emails.
          onEvent: onStripeEvent,
          organization: { enabled: true },
          subscription: {
            enabled: true,
            requireEmailVerification: true,
            // Per-seat plans: the Stripe quantity follows the workspace's member count.
            plans: [
              {
                name: 'team',
                priceId: env.stripe.monthlyPriceId,
                seatPriceId: env.stripe.monthlyPriceId,
                freeTrial: env.stripe.trialDays > 0 ? { days: env.stripe.trialDays } : undefined,
              },
              ...(env.stripe.annualPriceId
                ? [
                    {
                      name: 'team-annual',
                      priceId: env.stripe.annualPriceId,
                      seatPriceId: env.stripe.annualPriceId,
                      freeTrial: env.stripe.trialDays > 0 ? { days: env.stripe.trialDays } : undefined,
                    },
                  ]
                : []),
            ],
            // Only workspace owners/admins can start, change or cancel the subscription.
            authorizeReference: async ({ user, referenceId }) => isWorkspaceAdmin(user.id, referenceId),
            // Business-to-business checkout: invoices need the company's billing address and tax ID.
            // Payment methods are deliberately not listed, so the Dashboard settings decide.
            getCheckoutSessionParams: () => ({
              params: {
                integration_identifier: 'doccompare_team_seats_kqvhmwrt',
                billing_address_collection: 'required',
                tax_id_collection: { enabled: true },
                customer_update: { address: 'auto', name: 'auto' },
                allow_promotion_codes: true,
                ...(env.stripe!.automaticTax && { automatic_tax: { enabled: true } }),
              },
            }),
          },
        }),
      ]
    : []),
];

const options = {
  appName: env.appName,
  baseURL: env.baseUrl,
  basePath: '/api/auth',
  secret: env.authSecret,
  database: pool,
  trustedOrigins: [env.baseUrl, ...env.devOrigins],
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 256,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      await sendEmail({
        to: user.email,
        subject: `Reset your ${env.appName} password`,
        text: `Someone (hopefully you) asked to reset the password for ${user.email}. The link expires in 1 hour.\n\nIf you didn't ask for this, ignore this email; your password won't change.`,
        action: { label: 'Choose a new password', url },
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      await sendEmail({
        to: user.email,
        subject: `Confirm your email for ${env.appName}`,
        text: `Confirm ${user.email} to finish setting up your ${env.appName} account.`,
        action: { label: 'Confirm email', url },
      });
    },
  },
  socialProviders: {
    ...(env.google && { google: { ...env.google, prompt: 'select_account' as const } }),
    ...(env.microsoft && { microsoft: { ...env.microsoft, prompt: 'select_account' as const } }),
  },
  account: {
    // Let someone who signed up by email later use "Sign in with Google/Microsoft" for the same verified address.
    accountLinking: { enabled: true, trustedProviders: ['google', 'microsoft'] },
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  rateLimit: {
    enabled: !env.disableRateLimit,
    window: 60,
    max: 100,
    customRules: {
      '/sign-in/*': { window: 60, max: 10 },
      '/sign-up/*': { window: 60, max: 5 },
      '/forget-password': { window: 300, max: 5 },
      '/request-password-reset': { window: 300, max: 5 },
      '/two-factor/*': { window: 60, max: 10 },
    },
  },
  advanced: {
    useSecureCookies: env.isProd,
    cookiePrefix: 'doccompare',
    ipAddress: { ipAddressHeaders: [env.clientIpHeader] },
  },
  databaseHooks: {
    session: {
      create: {
        // Open the user's workspace automatically when they sign in.
        async before(session) {
          const m = await db
            .selectFrom('member')
            .select('organizationId')
            .where('userId', '=', session.userId)
            .executeTakeFirst()
            .catch(() => undefined);
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
  plugins,
} satisfies BetterAuthOptions;

export const auth = betterAuth(options);
export const authOptions: BetterAuthOptions = options;
