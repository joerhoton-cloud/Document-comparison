import { expect, test } from '@playwright/test';
import { emailedLink, signedInWithWorkspace, signUp, uniqueEmail } from './helpers';

test('a teammate continues a saved review without the documents ever being uploaded', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();

  // Record every request body the app sends: document text must never appear in one.
  const bodies: string[] = [];
  owner.on('request', (r) => {
    const b = r.postData();
    if (b) bodies.push(b);
  });

  await signedInWithWorkspace(owner, 'Olivia Owner', 'Acme Legal');

  // Owner compares with "Save review progress" and reviews two changes.
  await owner.getByText('Save review progress', { exact: true }).click();
  await owner.locator('input[type=file]').nth(0).setInputFiles('samples/contract-original.pdf');
  await owner.locator('input[type=file]').nth(1).setInputFiles('samples/contract-revised.docx');
  await owner.getByRole('button', { name: 'Compare documents' }).click();
  await expect(owner.locator('.save-state')).toHaveText('Saving review progress to Acme Legal');
  await expect(owner.locator('.review-progress')).toHaveText('0/14 reviewed');

  await owner.locator('.change-item.current').getByRole('button', { name: '✓ Reviewed' }).click();
  await expect(owner.locator('.review-progress')).toHaveText('1/14 reviewed');
  // Marking reviewed with the keyboard moves on; flag the second change and add a note.
  await owner.locator('.change-item').nth(1).locator('.ci-main').click();
  await owner.locator('.change-item.current').getByRole('button', { name: '⚑ Flag' }).click();
  await owner.locator('.change-item.current').getByRole('button', { name: 'Note', exact: true }).click();
  await owner.getByLabel('Note').fill('Check podcast coverage with sales');
  await owner.getByRole('button', { name: 'Save note' }).click();
  await expect(owner.locator('.review-progress')).toHaveText('1/14 reviewed · 1 flagged');

  // Invite a teammate from the Team page.
  await owner.getByRole('button', { name: 'Team', exact: true }).click();
  const tomEmail = uniqueEmail('tom');
  await owner.getByLabel('Invite by email').fill(tomEmail);
  await owner.getByRole('button', { name: 'Send invite' }).click();
  await expect(owner.locator('.member.pending')).toContainText(tomEmail);

  // Teammate follows the invitation, creates an account, and joins.
  const invite = new URL(await emailedLink(tomEmail));
  const tomCtx = await browser.newContext();
  const tom = await tomCtx.newPage();
  await signUp(tom, 'Tom Teammate', tomEmail, invite.pathname + invite.search);
  await expect(tom.getByRole('heading', { name: 'Join Acme Legal' })).toBeVisible();
  await tom.getByRole('button', { name: 'Join workspace' }).click();
  await expect(tom.getByRole('heading', { name: 'Compare two versions of a document' })).toBeVisible();

  // Tom picks the same files (in the other order) and is told Olivia already compared them.
  await tom.locator('input[type=file]').nth(0).setInputFiles('samples/contract-revised.docx');
  await tom.locator('input[type=file]').nth(1).setInputFiles('samples/contract-original.pdf');
  await expect(tom.locator('.match-banner')).toContainText('Olivia Owner already compared these files');
  await expect(tom.locator('.match-banner')).toContainText('1 of 14 reviewed · 1 flagged');
  await tom.getByRole('button', { name: 'Continue their review' }).click();

  // Olivia's marks and note are restored, with the original orientation.
  await expect(tom.locator('.review-progress')).toHaveText('1/14 reviewed · 1 flagged');
  await expect(tom.locator('.col-head.left .col-name')).toHaveText('contract-original.pdf');
  await expect(tom.locator('.change-item.mark-flagged .ci-note')).toContainText('“Check podcast coverage with sales” — Olivia Owner');
  // The first unreviewed change is selected; Tom marks it reviewed.
  await tom.locator('.change-item.current').getByRole('button', { name: '✓ Reviewed' }).click();
  await expect(tom.locator('.review-progress')).toHaveText('2/14 reviewed · 1 flagged');

  // History shows who did what.
  await tom.getByRole('button', { name: 'History' }).click();
  await expect(tom.locator('.table')).toContainText('contract-original.pdf');
  await expect(tom.locator('.table')).toContainText('2 of 14 reviewed · 1 flagged');
  await expect(tom.locator('.feed')).toContainText('Tom Teammate reopened');
  await expect(tom.locator('.feed')).toContainText('Olivia Owner flagged a change in');
  // Tom didn't create it and isn't an admin, so he can't delete it.
  await expect(tom.locator('.table').getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // No request ever carried document text.
  const docText = ['Media Monitoring Services Agreement', 'Late payments shall accrue', 'monthly executive summary'];
  for (const body of bodies) for (const t of docText) expect(body).not.toContain(t);

  await ownerCtx.close();
  await tomCtx.close();
});

test('"Don’t save" leaves no trace in the team history', async ({ page }) => {
  await signedInWithWorkspace(page, 'Pat Private');
  await page.getByText('Don’t save', { exact: true }).click();
  await page.getByRole('button', { name: 'Try the sample contracts' }).click();
  await expect(page.locator('.save-state')).toHaveText('Not saved. Only you can see this comparison.');
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.empty-state')).toContainText('Nothing saved yet');
});

test('signed-out visitors see the sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to DocCompare' })).toBeVisible();
  const res = await page.request.get('/api/comparisons');
  expect(res.status()).toBe(401);
});
