import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { file, watchConsole } from '../support/helpers';

const text = (path: string) => execFileSync('pdftotext', [path, '-']).toString();
const png = (spec: string, size: string) => execFileSync('convert', ['-size', size, spec, 'png:-'], { maxBuffer: 1 << 24 });

/** A page with two lines of real text and a noisy picture. */
async function sample(): Promise<Buffer> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([400, 400]);
  p.drawText('Invoice for Alice Smith', { x: 40, y: 350, size: 18, font });
  p.drawText('Payment due in 30 days', { x: 40, y: 320, size: 14, font });
  const img = await d.embedPng(png('plasma:red-yellow', '240x120'));
  p.drawImage(img, { x: 40, y: 150, width: 200, height: 100 });
  return Buffer.from(await d.save());
}

test.describe('edit the text and images already in a PDF', () => {
  test('retype a line, replace the picture, download: the old text and picture are gone from the file', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto('/edit-content');
    await page.setInputFiles('input[type=file]', file('invoice.pdf', await sample()));
    const canvas = page.getByTestId('content-page');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit text: Invoice for Alice Smith' })).toBeVisible();

    // Nothing changed yet: the page must refuse and say why.
    await page.getByRole('button', { name: 'Apply edits' }).click();
    await expect(page.getByText('Change some text or an image first.')).toBeVisible();

    await page.getByRole('button', { name: 'Edit text: Invoice for Alice Smith' }).click();
    await page.getByLabel('Replacement text').fill('Invoice for Robert Chen');
    await expect(page.getByText('1 change so far')).toBeVisible();

    await page.getByRole('button', { name: /^Image 1/ }).click();
    await page.locator('input[aria-label="Choose a replacement image"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png('xc:blue', '300x60') });
    await expect(page.getByText('Replacement: logo.png')).toBeVisible();
    await expect(page.getByText('2 changes so far')).toBeVisible();

    await page.getByRole('button', { name: 'Apply edits' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('invoice-edited.pdf');
    const path = await dl.path();
    const t = text(path);
    expect(t).toContain('Invoice for Robert Chen'); expect(t).not.toContain('Alice'); expect(t).toContain('Payment due in 30 days');
    const imgs = execFileSync('pdfimages', ['-list', path]).toString().trim().split('\n').slice(2);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatch(/\b300\s+60\b/); // only the NEW picture is left
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('delete a picture and a line of text', async ({ page }) => {
    await page.goto('/edit-content');
    await page.setInputFiles('input[type=file]', file('invoice.pdf', await sample()));
    await page.getByRole('button', { name: 'Edit text: Payment due in 30 days' }).click();
    await page.getByRole('button', { name: 'Delete this text' }).click();
    await page.getByRole('button', { name: /^Image 1/ }).click();
    await page.getByRole('button', { name: 'Delete image' }).click();
    await page.getByRole('button', { name: 'Apply edits' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    expect(text(path)).toContain('Alice Smith'); expect(text(path)).not.toContain('Payment due');
    expect(execFileSync('pdfimages', ['-list', path]).toString().trim().split('\n').slice(2)).toHaveLength(0);
  });

  test('a scanned/image-only page says there is nothing to edit instead of pretending', async ({ page }) => {
    const d = await PDFDocument.create();
    const p = d.addPage([300, 200]);
    p.drawImage(await d.embedPng(png('plasma:fractal', '300x200')), { x: 0, y: 0, width: 300, height: 200 });
    await page.goto('/edit-content');
    await page.setInputFiles('input[type=file]', file('scan.pdf', Buffer.from(await d.save())));
    await expect(page.getByTestId('content-page')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Edit text/ })).toHaveCount(0);
  });
});
