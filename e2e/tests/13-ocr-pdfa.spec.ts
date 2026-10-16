import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { file, watchConsole } from '../support/helpers';

const works = (bin: string | undefined, args: string[]) => {
  try { if (!bin) return false; execFileSync(bin, args, { stdio: 'ignore', env: { ...process.env, PATH: `${process.env.PDFTOOLS_BIN_DIR ?? ''}:${process.env.PATH}` } }); return true; } catch { return false; }
};
const haveOcr = works('tesseract', ['--version']);
const haveVera = works(process.env.VERAPDF_BIN, ['--version']);
if (process.env.CI && !(haveOcr && haveVera)) throw new Error('tesseract and veraPDF are required in CI');
if (!haveOcr || !haveVera) console.warn(`\n⚠ OCR/PDF-A UI tests partly skipped (tesseract: ${haveOcr}, veraPDF: ${haveVera}).\n`);

const dir = mkdtempSync(join(tmpdir(), 'e2e-ocr-'));
async function scanned(): Promise<Buffer> {
  const img = join(dir, 'scan.png');
  execFileSync('convert', ['-size', '1500x600', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '64', '-fill', 'black', '-annotate', '+60+130', 'Hello OCR world', '-annotate', '+60+280', 'Invoice 12345 total', '-colorspace', 'Gray', `png:${img}`]);
  const d = await PDFDocument.create();
  d.addPage([360, 144]).drawImage(await d.embedPng(readFileSync(img)), { x: 0, y: 0, width: 360, height: 144 });
  return Buffer.from(await d.save());
}

test.describe('OCR and PDF/A through the UI', () => {
  test('OCR: a scanned page becomes searchable; the settings explain what they do', async ({ page }) => {
    test.skip(!haveOcr, 'tesseract not installed');
    const mon = watchConsole(page);
    await page.goto('/ocr');
    await page.setInputFiles('input[type=file]', file('scan.pdf', await scanned()));
    await expect(page.getByLabel('Language')).toHaveValue('eng');
    await expect(page.getByText('Skip pages that already contain text')).toBeVisible();
    await page.getByRole('button', { name: 'OCR PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Recognition can contain mistakes|recognised text is stored invisibly/i).first()).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('scan-ocr.pdf');
    const t = execFileSync('pdftotext', [await dl.path(), '-']).toString().replace(/\s+/g, ' ');
    expect(t).toContain('Hello OCR world'); expect(t).toContain('Invoice 12345 total');
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('OCR: an unavailable language is explained, not silently ignored', async ({ page }) => {
    test.skip(!haveOcr, 'tesseract not installed');
    await page.goto('/ocr');
    await page.setInputFiles('input[type=file]', file('scan.pdf', await scanned()));
    await page.getByLabel('Language').fill('klingon');
    await page.getByRole('button', { name: 'OCR PDF' }).click();
    await expect(page.getByText(/language "klingon" is not installed/i)).toBeVisible({ timeout: 60_000 });
  });

  test('PDF/A: the delivered file is confirmed compliant by an independent veraPDF run, and the page says it was validated', async ({ page }) => {
    test.skip(!haveVera, 'veraPDF not available');
    const d = await PDFDocument.create();
    d.addPage([300, 200]).drawText('Archive me', { x: 20, y: 100, size: 16, font: await d.embedFont(StandardFonts.Helvetica) });
    await page.goto('/pdf-to-pdfa');
    await page.setInputFiles('input[type=file]', file('doc.pdf', Buffer.from(await d.save())));
    await page.getByLabel(/PDF\/A-2b/).check();
    await page.getByRole('button', { name: 'PDF to PDF/A' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Checked with veraPDF: the result conforms to PDF\/A-2b/)).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('doc-pdfa.pdf');
    const out = join(dir, 'dl.pdf'); writeFileSync(out, readFileSync(await dl.path()));
    let report = '';
    try { report = execFileSync(process.env.VERAPDF_BIN!, ['--flavour', '2b', out], { env: { ...process.env, JAVA_TOOL_OPTIONS: '-Xmx512m' }, maxBuffer: 1 << 26 }).toString(); } catch (e) { report = String((e as { stdout?: Buffer }).stdout ?? ''); }
    expect(report).toMatch(/isCompliant="true"/);
  });
});
