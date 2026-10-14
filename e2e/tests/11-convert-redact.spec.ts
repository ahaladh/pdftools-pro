import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { file, login, makePdf, watchConsole } from '../support/helpers';
import { readState } from '../support/stack';

// Redact is a premium tool; the seeded admin has the Business plan.
const loginAdmin = async (page: Page) => { const s = readState(); await login(page, s.adminEmail, s.adminPassword, '/admin'); await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible(); };
const text = (path: string, args: string[] = []) => execFileSync('pdftotext', [...args, path, '-']).toString();

test.describe('conversions and find-and-redact through the UI', () => {
  test('find-and-redact: type a term, the saved PDF no longer contains it, other pages keep their text', async ({ page }) => {
    const mon = watchConsole(page);
    await loginAdmin(page);
    await page.goto('/redact');
    await page.setInputFiles('input[type=file]', file('contract.pdf', await makePdf(2, { label: 'Confidential-Acme' })));
    await expect(page.getByRole('region', { name: 'Page canvas' })).toBeVisible();
    // Nothing to do yet: the button must refuse and explain.
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    await expect(page.getByText('Mark at least one area or enter text to find and redact.')).toBeVisible();
    await page.getByLabel('Find and redact text (optional)').fill('acme page 1');
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    expect(text(path, ['-f', '1', '-l', '1']).trim()).toBe('');
    expect(text(path, ['-f', '2', '-l', '2'])).toContain('Confidential-Acme page 2');
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('find-and-redact: a term that is not in the PDF is reported, not silently "done"', async ({ page }) => {
    await loginAdmin(page);
    await page.goto('/redact');
    await page.setInputFiles('input[type=file]', file('a.pdf', await makePdf(1)));
    await expect(page.getByRole('region', { name: 'Page canvas' })).toBeVisible();
    await page.getByLabel('Find and redact text (optional)').fill('not-in-this-document');
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    await expect(page.getByText(/None of the search terms were found/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toHaveCount(0);
  });

  test('PDF to Excel: upload, convert, download an XLSX with one sheet per page', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto('/pdf-to-excel');
    await page.setInputFiles('input[type=file]', file('report.pdf', await makePdf(2, { label: 'Total' })));
    await page.getByRole('button', { name: 'PDF to Excel' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('report.xlsx');
    const z = unzipSync(new Uint8Array(readFileSync(await dl.path())));
    expect(strFromU8(z['xl/worksheets/sheet1.xml']!)).toContain('Total page 1');
    expect(strFromU8(z['xl/worksheets/sheet2.xml']!)).toContain('Total page 2');
    expect(mon.problems).toEqual([]);
  });

  test('PDF to Word: produces a DOCX', async ({ page }) => {
    await page.goto('/pdf-to-word');
    await page.setInputFiles('input[type=file]', file('letter.pdf', await makePdf(1, { label: 'Dear' })));
    await page.getByRole('button', { name: 'PDF to Word' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('letter.docx');
    expect(strFromU8(unzipSync(new Uint8Array(readFileSync(await dl.path())))['word/document.xml']!)).toContain('Dear page 1');
  });
});
