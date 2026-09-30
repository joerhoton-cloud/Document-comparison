import { env } from './env';

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** A single call-to-action link, rendered as a button in the HTML version. */
  action?: { label: string; url: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Emails sent in development, for tests and local inspection. */
export const devOutbox: Email[] = [];

export async function sendEmail(mail: Email): Promise<void> {
  if (!env.resendApiKey) {
    devOutbox.push(mail);
    if (devOutbox.length > 50) devOutbox.shift();
    console.info(`[email] to=${mail.to} subject="${mail.subject}"${mail.action ? ` link=${mail.action.url}` : ''}`);
    return;
  }
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#1b2130;max-width:520px">
<p>${esc(mail.text).replace(/\n/g, '<br>')}</p>
${mail.action ? `<p><a href="${esc(mail.action.url)}" style="display:inline-block;background:#2f5bea;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(mail.action.label)}</a></p><p style="color:#5a6376;font-size:13px">Or paste this link into your browser:<br>${esc(mail.action.url)}</p>` : ''}
</div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.emailFrom,
      to: mail.to,
      subject: mail.subject,
      text: mail.text + (mail.action ? `\n\n${mail.action.label}: ${mail.action.url}` : ''),
      html,
    }),
  });
  if (!res.ok) throw new Error(`Email delivery failed (${res.status})`);
}
