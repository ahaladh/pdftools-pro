import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from '@cantoo/pdf-lib';
import { file, watchConsole } from '../support/helpers';

const text = (path: string) => execFileSync('pdftotext', ['-layout', path, '-']).toString();

async function formPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  const form = doc.getForm();
  form.createTextField('full_name').addToPage(page, { x: 20, y: 440, width: 220, height: 24 });
  form.createCheckBox('newsletter').addToPage(page, { x: 20, y: 400, width: 18, height: 18 });
  const rg = form.createRadioGroup('plan');
  for (const [i, o] of ['basic', 'premium'].entries()) rg.addOptionToPage(o, page, { x: 20 + i * 70, y: 360, width: 16, height: 16 });
  const dd = form.createDropdown('country'); dd.addOptions(['India', 'Norway']); dd.addToPage(page, { x: 20, y: 310, width: 150, height: 24 });
  return Buffer.from(await doc.save());
}

test.describe('fill a PDF form through the UI', () => {
  test('fill every field type, flatten, and an independent extractor reads the answers', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto('/fill-form');
    await page.setInputFiles('input[type=file]', file('form.pdf', await formPdf()));
    await expect(page.getByRole('heading', { name: 'Form fields (4)' })).toBeVisible();
    // Nothing entered yet: the button refuses and explains.
    await page.getByRole('button', { name: 'Fill PDF form' }).click();
    await expect(page.getByText('Fill in at least one field first.')).toBeVisible();

    await page.getByLabel('full_name').fill('Åsa Lindqvist');
    await page.getByLabel('newsletter').check();
    await page.getByLabel('premium').check();
    await page.getByLabel('country').selectOption('Norway');
    await page.getByLabel(/Make the answers permanent/).check();
    await page.getByRole('button', { name: 'Fill PDF form' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    const t = text(path);
    expect(t).toContain('Åsa Lindqvist'); expect(t).toContain('Norway');
    const out = await PDFDocument.load(await (await import('node:fs/promises')).readFile(path));
    expect(out.getForm().getFields()).toHaveLength(0);
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test("the field's length limit is enforced as you type", async ({ page }) => {
    const doc = await PDFDocument.create();
    const pg = doc.addPage([300, 200]);
    const tf = doc.getForm().createTextField('code'); tf.setMaxLength(3); tf.addToPage(pg, { x: 20, y: 100, width: 100, height: 24 });
    await page.goto('/fill-form');
    await page.setInputFiles('input[type=file]', file('f.pdf', Buffer.from(await doc.save())));
    // The input has maxlength, so the browser already stops typing at 3.
    await page.getByLabel('code').fill('abcdef');
    await expect(page.getByLabel('code')).toHaveValue('abc');
  });

  test('a PDF with no fields says so and points to Edit PDF', async ({ page }) => {
    const doc = await PDFDocument.create(); doc.addPage([200, 200]);
    await page.goto('/fill-form');
    await page.setInputFiles('input[type=file]', file('plain.pdf', Buffer.from(await doc.save())));
    await expect(page.getByText(/no fillable form fields/)).toBeVisible();
    await expect(page.getByRole('alert').getByRole('link', { name: 'Edit PDF' })).toHaveAttribute('href', '/edit');
  });
});
