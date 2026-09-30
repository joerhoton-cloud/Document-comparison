import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

let seq = 0;
export const uniqueEmail = (who: string) => `${who}-${Date.now()}-${seq++}@example.test`;

/** Most recent link emailed to `email` (the dev server logs emails instead of sending them). */
export async function emailedLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const log = readFileSync('.e2e-server.log', 'utf8');
    const lines = log.split('\n').filter((l) => l.includes(`[email] to=${email} `));
    const link = lines.at(-1)?.match(/link=(\S+)/)?.[1];
    if (link) return link;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email sent to ${email}`);
}

/** Create an account through the UI and confirm it via the emailed link. */
export async function signUp(page: Page, name: string, email: string, path = '/') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailedLink(email));
}

/** A signed-in user with their own workspace, ready to compare. */
export async function signedInWithWorkspace(page: Page, name = 'Test User', workspace = 'Test Workspace') {
  const email = uniqueEmail(name.split(' ')[0].toLowerCase());
  await signUp(page, name, email);
  await page.getByLabel('Workspace name').fill(workspace);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Compare two versions of a document' })).toBeVisible();
  return email;
}
