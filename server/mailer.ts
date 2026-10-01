import { createTransport, type Transporter } from 'nodemailer';
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

let smtp: Transporter | undefined;

async function deliver(mail: Email): Promise<void> {
  if (!env.resendApiKey && !env.smtpUrl) {
    devOutbox.push(mail);
    if (devOutbox.length > 50) devOutbox.shift();
    console.info(`[email] to=${mail.to} subject="${mail.subject}"${mail.action ? ` link=${mail.action.url}` : ''}`);
    return;
  }
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#1b2130;max-width:520px">
<p>${esc(mail.text).replace(/\n/g, '<br>')}</p>
${mail.action ? `<p><a href="${esc(mail.action.url)}" style="display:inline-block;background:#2f5bea;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(mail.action.label)}</a></p><p style="color:#5a6376;font-size:13px">Or paste this link into your browser:<br>${esc(mail.action.url)}</p>` : ''}
</div>`;
  const text = mail.text + (mail.action ? `\n\n${mail.action.label}: ${mail.action.url}` : '');
  if (env.smtpUrl) {
    smtp ??= createTransport(env.smtpUrl);
    await smtp.sendMail({ from: env.emailFrom, to: mail.to, subject: mail.subject, text, html });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.emailFrom,
      to: mail.to,
      subject: mail.subject,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Email delivery failed (${res.status})`);
}

/** Send an email, logging failures (without credentials) so they show up in the host's logs. */
export async function sendEmail(mail: Email): Promise<void> {
  try {
    await deliver(mail);
    if (env.smtpUrl || env.resendApiKey) console.info(`[email] sent "${mail.subject}" to ${mail.to}`);
  } catch (err) {
    console.error(`[email] FAILED to send "${mail.subject}" to ${mail.to}: ${(err as Error).message}`);
    throw err;
  }
}

/** Check the SMTP login at startup so a bad password shows up in the logs immediately. */
export async function checkEmailSetup(): Promise<void> {
  if (!env.smtpUrl) return;
  let host = 'SMTP server';
  let user = '';
  try {
    const u = new URL(env.smtpUrl);
    host = u.hostname;
    user = decodeURIComponent(u.username);
    if (u.username.includes('@')) console.warn('[email] SMTP_URL: write the @ in the username as %40, e.g. you%40gmail.com');
  } catch {
    console.error('[email] SMTP_URL is not a valid URL. Expected smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465');
    return;
  }
  try {
    smtp ??= createTransport(env.smtpUrl);
    await smtp.verify();
    console.info(`[email] SMTP login OK (${user} @ ${host})`);
  } catch (err) {
    const msg = (err as Error).message;
    const hint = /535|Username and Password not accepted|Invalid login/i.test(msg)
      ? ' Gmail rejected the login: check the app password (16 letters, no spaces) and that the address is written you%40gmail.com.'
      : '';
    console.error(`[email] SMTP login FAILED for ${user} @ ${host}: ${msg}.${hint}`);
  }
}
