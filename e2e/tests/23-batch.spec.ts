import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { PDFDocument } from '@cantoo/pdf-lib';
import { strFromU8, unzipSync } from 'fflate';
import { file, login, makePdf, watchConsole } from '../support/helpers';
import { readState } from '../support/stack';

const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const broken = (name: string) => file(name, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not really a pdf')]));

test('guests see batch mode as a paid feature; tools that cannot be batched do not offer it', async ({ page }) => {
  await page.goto('/rotate');
  const box = page.getByRole('checkbox', { name: /Batch mode/ });
  await expect(box).toBeVisible(); await expect(box).toBeDisabled();
  await expect(page.getByText('Batch mode is included in the paid plans')).toBeVisible();
  await expect(page.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/pricing');
  await axe(page, 'batch teaser');
  await page.goto('/merge'); // merge already takes many files and is not one-in, one-out
  await expect(page.getByRole('checkbox', { name: /Batch mode/ })).toHaveCount(0);
});

test('a paid user runs one tool on many files: one archive, a result for each, failures reported, and the numbers say so', async ({ page }) => {
  test.setTimeout(120_000);
  const mon = watchConsole(page);
  const st = readState();
  await login(page, st.adminEmail, st.adminPassword, '/rotate'); // the seeded administrator is on the Business plan
  await expect(page.getByRole('heading', { name: 'Rotate PDF', level: 1 })).toBeVisible();
  const box = page.getByRole('checkbox', { name: /Batch mode/ });
  await expect(box).toBeEnabled();
  await expect(page.getByText(/Up to 100 files at once; each counts as one operation/)).toBeVisible();
  await box.check();
  await axe(page, 'batch mode on');

  await page.setInputFiles('input[type=file]', [file('one.pdf', await makePdf(1, { label: 'One' })), file('two.pdf', await makePdf(2, { label: 'Two' })), broken('bad.pdf')]);
  const list = page.getByRole('list').filter({ hasText: 'bad.pdf' });
  await expect(list).toContainText('one.pdf'); await expect(list).toContainText('two.pdf');
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Batch summary')).toHaveText('2 of 3 files processed, 1 could not be. The archive includes a report.');
  await expect(page.getByText(/1 of 3 files could not be processed.*bad\.pdf/)).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  expect(dl.suggestedFilename()).toBe('batch-rotate-2-files.zip');
  const zip = unzipSync(new Uint8Array(readFileSync((await dl.path())!)));
  const pdfs = Object.keys(zip).filter((k) => k.endsWith('.pdf')).sort();
  expect(pdfs).toHaveLength(2);
  for (const k of pdfs) expect((await PDFDocument.load(zip[k]!)).getPage(0).getRotation().angle).toBe(90); // the tool's default option, applied to each
  const report = strFromU8(zip['batch-report.txt']!);
  expect(report).toMatch(/Files: 3, processed: 2, failed: 1/); expect(report).toMatch(/FAILED  bad\.pdf/); expect(report).toMatch(/OK  one\.pdf/); expect(report).toMatch(/OK  two\.pdf/);
  expect(mon.problems).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});

test('switching batch mode off goes back to one file, and the single-file result is an ordinary PDF', async ({ page }) => {
  const st = readState();
  await login(page, st.adminEmail, st.adminPassword, '/rotate');
  const box = page.getByRole('checkbox', { name: /Batch mode/ });
  await box.check();
  await page.setInputFiles('input[type=file]', [file('a.pdf', await makePdf(1)), file('b.pdf', await makePdf(1))]);
  await expect(page.getByRole('list').filter({ hasText: 'b.pdf' })).toBeVisible();
  await box.uncheck();
  await expect(page.getByRole('list').filter({ hasText: 'b.pdf' })).toHaveCount(0); // only the first file stays
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Batch summary')).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.pdf$/);
});
