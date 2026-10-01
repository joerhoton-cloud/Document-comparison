import { expect, test } from '@playwright/test';
import { signedInWithWorkspace } from './helpers';

test.setTimeout(180_000);

test('reads a scanned (image-only) PDF with in-browser OCR and finds the edits', async ({ page }) => {
  const external: string[] = [];
  const origin = new URL(test.info().project.use.baseURL!).origin;
  page.on('request', (r) => {
    if (!/^(blob|data):/.test(r.url()) && new URL(r.url()).origin !== origin) external.push(r.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('status of 401') && errors.push(m.text()));

  await signedInWithWorkspace(page);
  await page.locator('input[type=file]').nth(0).setInputFiles('samples/contract-original-scanned.pdf');
  await page.locator('input[type=file]').nth(1).setInputFiles('samples/contract-revised.docx');
  await page.getByRole('button', { name: 'Compare documents' }).click();
  await expect(page.locator('.results')).toBeVisible({ timeout: 150_000 });

  await expect(page.locator('.col-head.left .ocr-note')).toContainText('text recognized (OCR)');
  // The real edits are found in the recognized text.
  await expect(page.locator('.cell.right ins', { hasText: 'Delaware' })).toBeVisible();
  await expect(page.locator('.cell.left del', { hasText: 'Illinois' })).toBeVisible();
  await expect(page.locator('.cell.right ins', { hasText: '52,500' })).toBeVisible();
  await expect(page.locator('.row.deleted', { hasText: 'Late payments' })).toBeVisible();
  // OCR should be close to the original: most text matches.
  const match = Number((await page.locator('.similarity').textContent())!.replace(/[^0-9.]/g, ''));
  console.log(`OCR'd scan vs revised: ${match}% match, ${await page.locator('.summary .total').textContent()}`);
  expect(match).toBeGreaterThan(75);

  expect(external).toEqual([]); // the scan and the OCR engine never leave this origin
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/ocr-scanned-pdf.png' });
});

test('reads a photo of a page (PNG)', async ({ page }) => {
  await signedInWithWorkspace(page);
  await page.locator('input[type=file]').nth(0).setInputFiles('samples/contract-original.docx');
  await page.locator('input[type=file]').nth(1).setInputFiles('samples/contract-revised-page1.png');
  await page.getByRole('button', { name: 'Compare documents' }).click();
  await expect(page.locator('.results')).toBeVisible({ timeout: 150_000 });
  await expect(page.locator('.col-head.right .ocr-note')).toContainText('Scanned image');
  await expect(page.locator('.cell.right ins', { hasText: 'February' })).toBeVisible();
});
