import { expect, test } from '@playwright/test';

const sample = (name: string) => `samples/${name}`;

async function compare(page: import('@playwright/test').Page, left: string, right: string) {
  await page.goto('/');
  const inputs = page.locator('input[type=file]');
  await inputs.nth(0).setInputFiles(sample(left));
  await page.locator('input[type=file]').nth(1).setInputFiles(sample(right));
  await page.getByRole('button', { name: 'Compare documents' }).click();
  await expect(page.locator('.results')).toBeVisible();
}

for (const [left, right] of [
  ['contract-original.docx', 'contract-revised.docx'],
  ['contract-original.pdf', 'contract-revised.pdf'],
  ['contract-original.pdf', 'contract-revised.docx'],
]) {
  test(`compares ${left} with ${right}`, async ({ page }) => {
    // Documents must never leave the browser: record any request to another origin.
    const origin = new URL(test.info().project.use.baseURL!).origin;
    const external: string[] = [];
    page.on('request', (r) => {
      if (!/^(blob|data):/.test(r.url()) && new URL(r.url()).origin !== origin) external.push(r.url());
    });
    // Page errors and console errors (including CSP violations) fail the test.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await compare(page, left, right);

    const list = page.locator('.change-item');
    await expect(list.first()).toBeVisible();
    await expect(page.locator('.row.modified').first()).toBeVisible();
    // Key edits from the sample contracts are detected.
    await expect(page.locator('.cell.left del', { hasText: '48,000' })).toBeVisible();
    await expect(page.locator('.cell.right ins', { hasText: '52,500' })).toBeVisible();
    await expect(page.locator('.cell.right ins', { hasText: 'Delaware' })).toBeVisible();
    await expect(page.locator('.row.deleted', { hasText: 'Late payments' })).toBeVisible();
    await expect(page.locator('.row.inserted', { hasText: 'monthly executive summary' })).toBeVisible();

    // Keyboard navigation moves the current difference.
    await page.keyboard.press('j');
    await expect(page.locator('.counter')).toHaveText(/^2 \//);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    await page.screenshot({ path: `test-results/${left}-vs-${right}.png`, fullPage: false });
  });
}

test('identical documents report no differences', async ({ page }) => {
  await compare(page, 'contract-original.docx', 'contract-original.txt');
  await expect(page.locator('.summary .total')).toHaveText('No differences');
});

test('exports an HTML report', async ({ page }) => {
  await compare(page, 'contract-original.docx', 'contract-revised.docx');
  await page.locator('.menu summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Comparison report (.html)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('contract-original-vs-contract-revised-report.html');
});

test('rejects unsupported files with a clear message', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').nth(0).setInputFiles({ name: 'x.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ\x90\x00') });
  await page.locator('input[type=file]').nth(1).setInputFiles(sample('contract-revised.docx'));
  await page.getByRole('button', { name: 'Compare documents' }).click();
  await expect(page.locator('.status.error')).toContainText('unsupported file type');
});
