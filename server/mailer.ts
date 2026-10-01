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
  if (!env.resendApiKey && !env.smtp) {
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
  if (env.smtp) {
    smtp ??= transport();
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
    if (env.smtp || env.resendApiKey) console.info(`[email] sent "${mail.subject}" to ${mail.to}`);
  } catch (err) {
    const reason = redact((err as Error).message);
    console.error(`[email] FAILED to send "${mail.subject}" to ${mail.to}: ${reason}`);
    // Rethrow a sanitized error: callers (and their loggers) never see credentials.
    throw new Error(`Email delivery failed: ${reason}`);
  }
}

function transport(): Transporter {
  const c = env.smtp!;
  return createTransport({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass } });
}

/** Remove secrets from text that may be logged. */
function redact(text: string): string {
  let out = text;
  for (const secret of [env.smtp?.pass, process.env.SMTP_PASS, process.env.SMTP_URL, env.resendApiKey]) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Check the SMTP login at startup so a bad password shows up in the logs immediately. */
export async function checkEmailSetup(): Promise<void> {
  if (!env.smtp) return;
  const { user, host } = env.smtp;
  try {
    smtp ??= transport();
    await smtp.verify();
    console.info(`[email] SMTP login OK (${user} @ ${host})`);
  } catch (err) {
    const msg = redact((err as Error).message);
    const hint = /535|Username and Password not accepted|Invalid login/i.test(msg)
      ? ' The server rejected the login: check SMTP_PASS (for Gmail, a 16-letter app password from myaccount.google.com/apppasswords).'
      : '';
    console.error(`[email] SMTP login FAILED for ${user} @ ${host}: ${msg}.${hint}`);
  }
}
