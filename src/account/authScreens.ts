import { clear, h, icon } from '../ui/dom';
import { call } from './http';
import { isAdminRole, type Me, type PublicConfig } from './types';

/*
 * Screens shown before the comparison tool: sign in / sign up, two-factor code,
 * password reset, invitation, workspace creation and plan selection.
 * Each renders into `root` and calls `done()` when the user can move on.
 */

let fieldSeq = 0;

export function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const id = input.id || `f${++fieldSeq}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint && h('p', { class: 'hint' }, hint));
}

export function notice(el: HTMLElement, message: string, kind: 'error' | 'success' | 'info' = 'error') {
  el.className = `notice ${kind}`;
  el.textContent = message;
  el.hidden = !message;
}

/** Disable a form's controls while an async action runs. */
async function busy<T>(form: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const controls = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')];
  controls.forEach((c) => (c.disabled = true));
  try {
    return await fn();
  } finally {
    controls.forEach((c) => (c.disabled = false));
  }
}

function card(title: string, subtitle: string | null, ...children: (Node | false | null | undefined)[]) {
  return h(
    'section',
    { class: 'auth-card' },
    h('h1', null, title),
    subtitle && h('p', { class: 'auth-sub' }, subtitle),
    ...children,
  );
}

const PROVIDER_LABEL: Record<string, string> = { microsoft: 'Continue with Microsoft', google: 'Continue with Google' };

/** Sign in or create an account. `mode` picks the initial tab. */
export function renderSignIn(root: HTMLElement, config: PublicConfig, done: () => void, mode: 'sign-in' | 'sign-up' = 'sign-in') {
  clear(root);
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' });
  const password = h('input', { type: 'password', autocomplete: mode === 'sign-in' ? 'current-password' : 'new-password', minlength: mode === 'sign-up' ? 12 : undefined });
  const name = h('input', { type: 'text', autocomplete: 'name', required: true });
  const callbackURL = location.pathname + location.search;

  const social = config.providers.length
    ? h(
        'div',
        { class: 'social' },
        ...config.providers.map((p) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn lg social-btn',
              onclick: async () => {
                const res = await call<{ url?: string }>('/api/auth/sign-in/social', { json: { provider: p, callbackURL } });
                if (res.ok && res.data?.url) location.assign(res.data.url);
                else notice(msg, res.message || 'Could not start sign-in.');
              },
            },
            PROVIDER_LABEL[p] ?? p,
          ),
        ),
        h('div', { class: 'divider' }, h('span', null, 'or use email')),
      )
    : null;

  if (mode === 'sign-up') {
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      field('Your name', name),
      field('Work email', email),
      field('Password', password, 'At least 12 characters.'),
      h('button', { type: 'submit', class: 'btn primary lg block' }, 'Create account'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!name.value.trim() || !email.value.includes('@') || password.value.length < 12)
        return notice(msg, 'Enter your name, a valid email and a password of at least 12 characters.');
      const res = await busy(form, () =>
        call('/api/auth/sign-up/email', { json: { name: name.value.trim(), email: email.value.trim(), password: password.value, callbackURL } }),
      );
      if (!res.ok) return notice(msg, res.message);
      clear(root);
      root.append(
        card(
          'Check your email',
          null,
          h('p', null, 'We sent a confirmation link to ', h('strong', null, email.value.trim()), '. Open it on this device to finish creating your account.'),
          h('button', { class: 'btn ghost', onclick: () => renderSignIn(root, config, done) }, icon('back'), 'Back to sign in'),
        ),
      );
    });
    root.append(
      card(
        'Create your account',
        config.billingEnabled && config.trialDays ? `Start with a ${config.trialDays}-day free trial for your team.` : 'Set up your team workspace in a minute.',
        social,
        form,
        msg,
        h('p', { class: 'auth-switch' }, 'Already have an account? ', h('button', { class: 'link', onclick: () => renderSignIn(root, config, done) }, 'Sign in')),
      ),
    );
    return;
  }

  const form = h(
    'form',
    { class: 'form', novalidate: true },
    field('Work email', email),
    field('Password', password),
    h('button', { type: 'submit', class: 'btn primary lg block' }, 'Sign in'),
    h(
      'div',
      { class: 'form-row' },
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: async () => {
            if (!email.value.includes('@')) return notice(msg, 'Enter your email first.');
            const res = await busy(form, () => call('/api/auth/sign-in/magic-link', { json: { email: email.value.trim(), callbackURL } }));
            if (!res.ok) return notice(msg, res.message);
            notice(msg, `We emailed a sign-in link to ${email.value.trim()}. It expires in 10 minutes.`, 'success');
          },
        },
        'Email me a sign-in link instead',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: async () => {
            if (!email.value.includes('@')) return notice(msg, 'Enter your email first.');
            await busy(form, () => call('/api/auth/request-password-reset', { json: { email: email.value.trim(), redirectTo: '/?reset=1' } }));
            // Same message whether or not the account exists, so emails can't be probed.
            notice(msg, `If ${email.value.trim()} has an account, we've sent a password reset link.`, 'success');
          },
        },
        'Forgot password?',
      ),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.includes('@') || !password.value) return notice(msg, 'Enter your email and password.');
    const res = await busy(form, () => call<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', { json: { email: email.value.trim(), password: password.value } }));
    if (!res.ok) {
      if (res.status === 403) return notice(msg, 'Confirm your email first. We sent you a link when you signed up.');
      if (res.status === 401) return notice(msg, 'That email and password don’t match.');
      return notice(msg, res.message);
    }
    if (res.data?.twoFactorRedirect) return renderTwoFactor(root, done);
    done();
  });

  root.append(
    card(
      `Sign in to ${config.appName}`,
      'Compare document versions privately. Your files never leave your device.',
      social,
      form,
      msg,
      h('p', { class: 'auth-switch' }, 'New here? ', h('button', { class: 'link', onclick: () => renderSignIn(root, config, done, 'sign-up') }, 'Create an account')),
    ),
  );
  email.focus();
}

export function renderTwoFactor(root: HTMLElement, done: () => void) {
  clear(root);
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 11, class: 'code-input' });
  const trust = h('input', { type: 'checkbox' });
  let backup = false;
  const label = h('span', null, 'Authentication code');
  const form = h(
    'form',
    { class: 'form' },
    h('div', { class: 'field' }, h('label', { for: 'tf-code' }, label), Object.assign(code, { id: 'tf-code' })),
    h('label', { class: 'opt' }, trust, h('span', null, 'Trust this device for 30 days')),
    h('button', { type: 'submit', class: 'btn primary lg block' }, 'Verify'),
    h(
      'button',
      {
        type: 'button',
        class: 'link',
        onclick: (e: Event) => {
          backup = !backup;
          label.textContent = backup ? 'Backup code' : 'Authentication code';
          (e.target as HTMLElement).textContent = backup ? 'Use your authenticator app' : 'Use a backup code';
          code.value = '';
          code.focus();
        },
      },
      'Use a backup code',
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await busy(form, () =>
      call(backup ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp', {
        json: { code: code.value.replace(/\s/g, ''), trustDevice: trust.checked },
      }),
    );
    if (!res.ok) return notice(msg, res.status === 401 ? 'That code isn’t valid. Try the latest code from your app.' : res.message);
    done();
  });
  root.append(card('Two-step verification', 'Enter the 6-digit code from your authenticator app.', form, msg));
  code.focus();
}

export function renderResetPassword(root: HTMLElement, token: string, done: () => void) {
  clear(root);
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 });
  const form = h('form', { class: 'form' }, field('New password', pw, 'At least 12 characters.'), h('button', { type: 'submit', class: 'btn primary lg block' }, 'Set new password'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (pw.value.length < 12) return notice(msg, 'Use at least 12 characters.');
    const res = await busy(form, () => call('/api/auth/reset-password', { json: { newPassword: pw.value, token } }));
    if (!res.ok) return notice(msg, res.status === 400 ? 'This reset link has expired. Request a new one from the sign-in page.' : res.message);
    history.replaceState(null, '', '/');
    notice(msg, 'Password updated. Sign in with your new password.', 'success');
    setTimeout(done, 1200);
  });
  root.append(card('Choose a new password', null, form, msg));
}

/** Accept (or decline) a workspace invitation from an emailed link. */
export async function renderInvitation(root: HTMLElement, invitationId: string, done: () => void) {
  clear(root);
  const res = await call<{ organizationName?: string; inviterEmail?: string; email?: string; organizationId?: string }>(
    `/api/auth/organization/get-invitation?id=${encodeURIComponent(invitationId)}`,
  );
  const finish = () => {
    history.replaceState(null, '', '/');
    done();
  };
  if (!res.ok || !res.data) {
    root.append(
      card(
        'Invitation not available',
        'This invitation has expired, was already used, or was sent to a different email address than the one you signed in with.',
        h('button', { class: 'btn', onclick: finish }, 'Continue'),
      ),
    );
    return;
  }
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const inv = res.data;
  root.append(
    card(
      `Join ${inv.organizationName}`,
      `${inv.inviterEmail} invited you to this workspace. Members can see who compared which files and share review progress. Documents themselves are never shared or uploaded.`,
      h(
        'div',
        { class: 'form-row' },
        h(
          'button',
          {
            class: 'btn primary lg',
            onclick: async () => {
              const r = await call('/api/auth/organization/accept-invitation', { json: { invitationId } });
              if (!r.ok) return notice(msg, r.message);
              await call('/api/auth/organization/set-active', { json: { organizationId: inv.organizationId } });
              finish();
            },
          },
          'Join workspace',
        ),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              await call('/api/auth/organization/reject-invitation', { json: { invitationId } });
              finish();
            },
          },
          'Decline',
        ),
      ),
      msg,
    ),
  );
}

export function renderCreateWorkspace(root: HTMLElement, me: Me, done: () => void) {
  clear(root);
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Cision Legal', autocomplete: 'organization' });
  const form = h(
    'form',
    { class: 'form' },
    field('Workspace name', name, 'Usually your company or team name. You can invite colleagues next.'),
    h('button', { type: 'submit', class: 'btn primary lg block' }, 'Create workspace'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (n.length < 2) return notice(msg, 'Enter a workspace name.');
    const slug = `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace'}-${Math.random().toString(36).slice(2, 7)}`;
    const res = await busy(form, () => call<{ id: string }>('/api/auth/organization/create', { json: { name: n, slug } }));
    if (!res.ok) return notice(msg, res.message);
    await call('/api/auth/organization/set-active', { json: { organizationId: res.data.id } });
    done();
  });
  root.append(
    card(
      `Welcome, ${me.user.name.split(' ')[0]}`,
      'Create a workspace for your team. If a colleague already set one up, ask them to invite you instead.',
      form,
      msg,
    ),
  );
  name.focus();
}

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Subscription required: owners/admins pick a plan (Stripe Checkout), members are told who to ask. */
export function renderPlan(root: HTMLElement, me: Me, config: PublicConfig, onSignOut: () => void) {
  clear(root);
  const ws = me.workspace!;
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const lapsed = ws.subscription && ws.subscription.status && !['active', 'trialing', 'past_due'].includes(ws.subscription.status);

  if (!isAdminRole(ws.role)) {
    root.append(
      card(
        `${ws.name} needs a subscription`,
        'Only workspace owners and admins can manage billing. Ask the person who invited you to start or renew the plan.',
        h('button', { class: 'btn ghost', onclick: onSignOut }, 'Sign out'),
      ),
    );
    return;
  }

  const plans = config.prices.length ? config.prices : [{ plan: 'team', interval: 'month', amount: 0, currency: 'usd' }];
  const choose = async (plan: string) => {
    const res = await call<{ url?: string }>('/api/auth/subscription/upgrade', {
      json: {
        plan,
        customerType: 'organization',
        referenceId: ws.id,
        seats: ws.members,
        successUrl: `${location.origin}/?billing=success`,
        cancelUrl: `${location.origin}/?billing=cancelled`,
        disableRedirect: true,
      },
    });
    if (res.ok && res.data?.url) location.assign(res.data.url);
    else notice(msg, res.message || 'Could not open checkout. Try again.');
  };

  root.append(
    card(
      lapsed ? 'Renew your subscription' : 'Choose your plan',
      `${ws.name} has ${ws.members} member${ws.members === 1 ? '' : 's'}. You pay per member, and seats adjust automatically when people join or leave.`,
      h(
        'div',
        { class: 'plans' },
        ...plans.map((p) =>
          h(
            'div',
            { class: 'plan' },
            h('h2', null, p.plan === 'team-annual' ? 'Team, billed yearly' : 'Team, billed monthly'),
            h(
              'p',
              { class: 'price' },
              p.amount ? money(p.amount, p.currency) : '',
              h('span', null, p.amount ? ` per member / ${p.interval}` : `Billed per member each ${p.interval}`),
            ),
            h(
              'ul',
              null,
              h('li', null, 'Unlimited comparisons: PDF, Word, HTML and text'),
              h('li', null, 'Shared review progress and team history'),
              h('li', null, 'Documents stay on each person’s device'),
            ),
            h(
              'button',
              { class: 'btn primary lg block', onclick: () => choose(p.plan) },
              config.trialDays && !lapsed ? `Start ${config.trialDays}-day free trial` : 'Continue to payment',
            ),
          ),
        ),
      ),
      msg,
      h('p', { class: 'hint' }, 'Payments are handled by Stripe. You can cancel any time from the Team page.'),
    ),
  );
}
