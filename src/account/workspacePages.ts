import qrcode from 'qrcode-generator';
import { clear, formatBytes, h, icon } from '../ui/dom';
import { field, notice } from './authScreens';
import { call } from './http';
import { isAdminRole, type ActivityItem, type Me, type SavedComparison } from './types';

const when = (iso: string) => {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400 && d.getDate() === new Date().getDate()) return `today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

const ACTION_TEXT: Record<string, string> = {
  created: 'compared',
  opened: 'reopened',
  reviewed: 'marked a change reviewed in',
  flagged: 'flagged a change in',
  cleared: 'cleared a review mark in',
  deleted: 'deleted the saved comparison of',
  save_level: 'changed what is saved for',
};

export function progressLabel(c: SavedComparison): string {
  if (c.save_level !== 'progress') return 'Activity only';
  if (!c.stats.total) return 'No differences';
  return `${c.reviewed_count} of ${c.stats.total} reviewed${c.flagged_count ? ` · ${c.flagged_count} flagged` : ''}`;
}

/* ---------------------------------------------------------------- history */

export async function renderHistory(root: HTMLElement, me: Me, onResume: (c: SavedComparison) => void) {
  clear(root);
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(
    h('header', { class: 'page-head' }, h('h1', null, 'History'), h('p', null, `Comparisons saved in ${me.workspace!.name}. Only file names, sizes and fingerprints are stored — never the documents.`)),
  );
  const [list, feed] = await Promise.all([
    call<{ comparisons: SavedComparison[] }>('/api/comparisons?limit=100'),
    call<{ activity: ActivityItem[] }>('/api/activity?limit=60'),
  ]);
  if (!list.ok) {
    page.append(h('p', { class: 'notice error' }, list.message));
    return;
  }

  const table = h('div', { class: 'table-wrap' });
  if (!list.data.comparisons.length) {
    table.append(
      h('div', { class: 'empty-state' }, h('strong', null, 'Nothing saved yet'), h('p', null, 'Choose “Log activity” or “Save review progress” before comparing, and the comparison will appear here for your team.')),
    );
  } else {
    const rows = list.data.comparisons.map((c) => {
      const del =
        (c.created_by === me.user.id || isAdminRole(me.workspace!.role)) &&
        h(
          'button',
          {
            class: 'btn ghost sm',
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              if (btn.dataset.confirm !== '1') {
                btn.dataset.confirm = '1';
                btn.textContent = 'Confirm delete';
                btn.classList.add('danger');
                return;
              }
              const res = await call(`/api/comparisons/${c.id}`, { method: 'DELETE' });
              if (res.ok) renderHistory(root, me, onResume);
            },
          },
          'Delete',
        );
      return h(
        'tr',
        null,
        h(
          'td',
          { class: 'files' },
          h('span', { class: 'f-left', title: c.left_sha256 }, c.left_name),
          h('span', { class: 'f-arrow' }, '→'),
          h('span', { class: 'f-right', title: c.right_sha256 }, c.right_name),
          h('span', { class: 'f-meta' }, `${formatBytes(c.left_size)} · ${formatBytes(c.right_size)}`),
        ),
        h('td', null, c.created_by_name, h('span', { class: 'sub' }, when(c.created_at))),
        h('td', { class: 'num' }, String(c.stats.total)),
        h(
          'td',
          null,
          h('span', { class: `progress-pill ${c.save_level === 'progress' && c.reviewed_count >= c.stats.total && c.stats.total ? 'done' : ''}` }, progressLabel(c)),
          c.last_review_at && h('span', { class: 'sub' }, `updated ${when(c.last_review_at)}`),
        ),
        h('td', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => onResume(c) }, 'Open'), del),
      );
    });
    table.append(
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Documents'), h('th', null, 'Compared by'), h('th', { class: 'num' }, 'Differences'), h('th', null, 'Review'), h('th', null, ''))),
        h('tbody', null, ...rows),
      ),
    );
  }

  const activity = h(
    'ol',
    { class: 'feed' },
    ...(feed.ok ? feed.data.activity : []).map((a) =>
      h(
        'li',
        null,
        h('strong', null, a.user_name),
        ` ${ACTION_TEXT[a.action] ?? a.action} `,
        h('span', { class: 'feed-doc' }, a.left_name ? `${a.left_name} → ${a.right_name}` : a.detail.left ? `${a.detail.left} → ${a.detail.right}` : 'a comparison'),
        a.detail.note === true && ' with a note',
        h('span', { class: 'sub' }, when(a.created_at)),
      ),
    ),
  );
  page.append(h('div', { class: 'history-grid' }, h('section', null, h('h2', null, 'Saved comparisons'), table), h('aside', null, h('h2', null, 'Team activity'), activity)));
}

/* ------------------------------------------------------------------- team */

interface Member {
  id: string;
  role: string;
  userId: string;
  user: { name: string; email: string };
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

export async function renderTeam(root: HTMLElement, me: Me, refreshMe: () => Promise<void>) {
  clear(root);
  const ws = me.workspace!;
  const admin = isAdminRole(ws.role);
  const page = h('div', { class: 'page narrow' });
  root.append(page);
  const res = await call<{ members: Member[]; invitations: Invitation[] }>(`/api/auth/organization/get-full-organization?organizationId=${ws.id}`);
  page.append(h('header', { class: 'page-head' }, h('h1', null, ws.name), h('p', null, 'Everyone here can see the team history and continue each other’s reviews.')));
  if (!res.ok) {
    page.append(h('p', { class: 'notice error' }, res.message));
    return;
  }
  const msg = h('p', { class: 'notice', hidden: true, role: 'status' });

  const memberRows = res.data.members.map((m) =>
    h(
      'li',
      { class: 'member' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(m.user.name)),
      h('span', { class: 'who' }, h('strong', null, m.user.name, m.userId === me.user.id ? ' (you)' : ''), h('span', { class: 'sub' }, m.user.email)),
      h('span', { class: `role ${m.role}` }, m.role),
      admin &&
        m.role !== 'owner' &&
        m.userId !== me.user.id &&
        h(
          'button',
          {
            class: 'btn ghost sm',
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLButtonElement;
              if (btn.dataset.confirm !== '1') {
                btn.dataset.confirm = '1';
                btn.textContent = 'Confirm remove';
                btn.classList.add('danger');
                return;
              }
              const r = await call('/api/auth/organization/remove-member', { json: { memberIdOrEmail: m.id, organizationId: ws.id } });
              if (!r.ok) return notice(msg, r.message);
              await refreshMe();
              renderTeam(root, me, refreshMe);
            },
          },
          'Remove',
        ),
    ),
  );
  const pending = res.data.invitations.filter((i) => i.status === 'pending');
  const inviteRows = pending.map((i) =>
    h(
      'li',
      { class: 'member pending' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, '✉'),
      h('span', { class: 'who' }, h('strong', null, i.email), h('span', { class: 'sub' }, `Invited · expires ${new Date(i.expiresAt).toLocaleDateString()}`)),
      h('span', { class: 'role' }, i.role),
      admin &&
        h(
          'button',
          {
            class: 'btn ghost sm',
            onclick: async () => {
              await call('/api/auth/organization/cancel-invitation', { json: { invitationId: i.id } });
              renderTeam(root, me, refreshMe);
            },
          },
          'Cancel',
        ),
    ),
  );

  page.append(h('section', { class: 'panel' }, h('h2', null, `Members (${res.data.members.length})`), h('ul', { class: 'members' }, ...memberRows, ...inviteRows), msg));

  if (admin) {
    const email = h('input', { type: 'email', placeholder: 'colleague@company.com', required: true });
    const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'));
    const form = h('form', { class: 'invite-form' }, field('Invite by email', email), h('div', { class: 'field' }, h('label', null, 'Role'), role), h('button', { type: 'submit', class: 'btn primary' }, 'Send invite'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!email.value.includes('@')) return notice(msg, 'Enter an email address.');
      const r = await call('/api/auth/organization/invite-member', { json: { email: email.value.trim(), role: role.value, organizationId: ws.id } });
      if (!r.ok) return notice(msg, r.message);
      renderTeam(root, me, refreshMe);
    });
    page.append(
      h(
        'section',
        { class: 'panel' },
        form,
        h('p', { class: 'hint' }, me.billingEnabled ? 'Each member is a paid seat. Stripe adjusts your subscription automatically when someone joins or is removed.' : 'Admins can invite people and manage billing. Members can compare, save and review.'),
      ),
    );
  }

  if (me.billingEnabled) page.append(billingPanel(me));
}

function billingPanel(me: Me): HTMLElement {
  const ws = me.workspace!;
  const sub = ws.subscription;
  const msg = h('p', { class: 'notice', hidden: true, role: 'status' });
  const status = sub?.status ?? 'none';
  const lines: (string | false | null | undefined)[] = [
    sub && `Plan: ${sub.plan === 'team-annual' ? 'Team (yearly)' : 'Team (monthly)'}`,
    sub?.seats != null && `${sub.seats} seat${sub.seats === 1 ? '' : 's'}`,
    status === 'trialing' && sub?.trialEnd && `Free trial ends ${new Date(sub.trialEnd).toLocaleDateString()}`,
    status === 'active' && sub?.periodEnd && `${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${new Date(sub.periodEnd).toLocaleDateString()}`,
    status === 'past_due' && 'The last payment failed. Update your card to avoid losing access.',
  ];
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Billing'),
    h('p', null, h('span', { class: `status-pill ${status}` }, status.replace('_', ' ')), ' ', lines.filter(Boolean).join(' · ')),
    isAdminRole(ws.role)
      ? h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const r = await call<{ url?: string }>('/api/auth/subscription/billing-portal', {
                json: { customerType: 'organization', referenceId: ws.id, returnUrl: `${location.origin}/?page=team` },
              });
              if (r.ok && r.data?.url) location.assign(r.data.url);
              else notice(msg, r.message || 'Could not open the billing portal.');
            },
          },
          'Manage billing, invoices and payment method',
        )
      : h('p', { class: 'hint' }, 'Only owners and admins can change billing.'),
    msg,
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/* ---------------------------------------------------------------- account */

export function renderAccount(root: HTMLElement, me: Me, refreshMe: () => Promise<void>, onSignOut: () => void) {
  clear(root);
  const page = h('div', { class: 'page narrow' });
  root.append(page);
  page.append(h('header', { class: 'page-head' }, h('h1', null, 'Your account'), h('p', null, `${me.user.name} · ${me.user.email}`)));

  const msg = h('p', { class: 'notice', hidden: true, role: 'status' });
  const tf = h('section', { class: 'panel' });
  const renderTf = () => {
    clear(tf);
    tf.append(h('h2', null, 'Two-step verification'));
    const password = h('input', { type: 'password', autocomplete: 'current-password' });
    if (me.user.twoFactorEnabled) {
      tf.append(
        h('p', null, h('span', { class: 'status-pill active' }, 'on'), ' Sign-ins with a password also need a code from your authenticator app.'),
        field('Password', password),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const r = await call('/api/auth/two-factor/disable', { json: { password: password.value } });
              if (!r.ok) return notice(msg, r.status === 400 || r.status === 401 ? 'Incorrect password.' : r.message);
              await refreshMe();
              renderAccount(root, me, refreshMe, onSignOut);
            },
          },
          'Turn off',
        ),
      );
      return;
    }
    tf.append(
      h('p', null, 'Add a code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…) when signing in with a password.'),
      field('Confirm your password', password, 'Accounts that only use Microsoft/Google sign-in are protected by that provider instead.'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            const r = await call<{ totpURI: string; backupCodes: string[] }>('/api/auth/two-factor/enable', { json: { password: password.value } });
            if (!r.ok) return notice(msg, r.status === 400 || r.status === 401 ? 'Incorrect password.' : r.message);
            showTotpSetup(r.data.totpURI, r.data.backupCodes);
          },
        },
        'Set up',
      ),
    );
  };
  const showTotpSetup = (uri: string, backupCodes: string[]) => {
    clear(tf);
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, class: 'code-input' });
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    tf.append(
      h('h2', null, 'Scan with your authenticator app'),
      h('div', { class: 'totp' }, h('img', { src: qr.createDataURL(4, 8), alt: 'QR code for your authenticator app', width: 180, height: 180 }), h('div', null, h('p', { class: 'hint' }, 'Can’t scan? Enter this key:'), h('code', { class: 'secret' }, secret))),
      field('Enter the 6-digit code to finish', code),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            const r = await call('/api/auth/two-factor/verify-totp', { json: { code: code.value.trim() } });
            if (!r.ok) return notice(msg, 'That code didn’t match. Check the time on your phone and try the newest code.');
            await refreshMe();
            clear(tf);
            tf.append(
              h('h2', null, 'Two-step verification is on'),
              h('p', null, 'Save these backup codes somewhere safe. Each works once if you lose your phone.'),
              h('ul', { class: 'backup-codes' }, ...backupCodes.map((b) => h('li', null, h('code', null, b)))),
              h('button', { class: 'btn', onclick: () => renderAccount(root, me, refreshMe, onSignOut) }, 'Done'),
            );
          },
        },
        'Turn on',
      ),
    );
  };
  renderTf();
  page.append(tf, msg);

  page.append(
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Sessions'),
      h('p', null, 'Signing out everywhere ends your sessions on all browsers and devices.'),
      h(
        'div',
        { class: 'form-row' },
        h('button', { class: 'btn', onclick: onSignOut }, 'Sign out'),
        h(
          'button',
          {
            class: 'btn ghost',
            onclick: async () => {
              await call('/api/auth/revoke-sessions', { json: {} });
              onSignOut();
            },
          },
          'Sign out everywhere',
        ),
      ),
    ),
  );
}

/** Pick the two original files again to reopen a saved comparison; fingerprints must match. */
export function resumeDialog(
  c: SavedComparison,
  sha256: (f: File) => Promise<string | undefined>,
  onFiles: (left: File, right: File) => void,
  onCancel: () => void,
): HTMLElement {
  const msg = h('p', { class: 'notice', hidden: true, role: 'alert' });
  const picked: [File | null, File | null] = [null, null];
  const slot = (side: 0 | 1) => {
    const expected = side === 0 ? { name: c.left_name, sha: c.left_sha256 } : { name: c.right_name, sha: c.right_sha256 };
    const state = h('span', { class: 'rs-state' }, 'Not selected');
    const input = h('input', {
      type: 'file',
      class: 'visually-hidden',
      onchange: async (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        state.textContent = 'Checking…';
        const sha = await sha256(f);
        if (sha && sha !== expected.sha) {
          picked[side] = null;
          state.textContent = `${f.name} is a different file`;
          state.className = 'rs-state bad';
          return notice(msg, `That isn’t the same ${expected.name} that was compared: its contents differ. Pick the exact file, or start a new comparison instead.`);
        }
        picked[side] = f;
        state.textContent = `${f.name} ✓`;
        state.className = 'rs-state good';
        notice(msg, '');
        if (picked[0] && picked[1]) onFiles(picked[0], picked[1]);
      },
    });
    return h('label', { class: 'resume-slot' }, input, h('span', { class: 'slot-label' }, side === 0 ? 'Original' : 'Revised'), h('strong', null, expected.name), state, h('span', { class: 'btn sm' }, 'Choose file'));
  };
  return h(
    'div',
    { class: 'resume', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'resume-title' },
    h(
      'div',
      { class: 'resume-card' },
      h('h2', { id: 'resume-title' }, 'Open saved comparison'),
      h('p', null, `Documents aren’t stored, so select the same two files from your computer. ${c.save_level === 'progress' ? `Review progress (${progressLabel(c)}) will be restored.` : ''}`),
      h('div', { class: 'resume-slots' }, slot(0), slot(1)),
      msg,
      h('button', { class: 'btn ghost', onclick: onCancel }, icon('x', 14), 'Cancel'),
    ),
  );
}
