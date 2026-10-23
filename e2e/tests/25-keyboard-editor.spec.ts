import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { file, makePdf, watchConsole } from '../support/helpers';

const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};

/** Render page 1 at 72 dpi with Poppler (independent of our code) and return a pixel reader. PPM is trivial to parse. */
function render(pdfPath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kbd-'));
  execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', pdfPath, join(dir, 'p')]);
  const name = execFileSync('sh', ['-c', `ls ${dir}`]).toString().trim().split('\n')[0]!;
  const buf = readFileSync(join(dir, name));
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 40).toString('latin1'))!;
  const [w, h] = [Number(m[1]), Number(m[2])];
  const data = buf.subarray(buf.length - w * h * 3);
  return { w, h, at: (x: number, y: number) => [data[(y * w + x) * 3]!, data[(y * w + x) * 3 + 1]!, data[(y * w + x) * 3 + 2]!] as const };
}
const dark = (c: readonly number[]) => c[0]! < 60 && c[1]! < 60 && c[2]! < 80;
const white = (c: readonly number[]) => c.every((v) => v > 240);

test('a rectangle can be added, placed, nudged, resized and saved using only the keyboard, and it lands where the numbers say', async ({ page }) => {
  test.setTimeout(90_000);
  const mon = watchConsole(page);
  await page.goto('/edit');
  await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(1)));
  await expect(page.getByRole('region', { name: 'Page canvas' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Keyboard and screen-reader controls' });
  const status = panel.getByRole('status');
  await expect(panel).toContainText('Nothing on this page yet.');
  await axe(page, 'keyboard panel');

  await page.getByLabel('Fill shapes').check(); // solid, so a pixel in the middle is a clear signal

  // add: focus the picker (it starts on Rectangle), Tab to the button, Enter. Focus then lands in the first position field.
  await panel.getByLabel('What to add').focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Add to page 1' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(status).toContainText('Rectangle 1 added to page 1, at 35% across, 40% down, 30% wide, 12% tall');
  await expect(panel.getByLabel('Across (%)')).toBeFocused();
  await expect(panel.getByRole('button', { name: /^Rectangle 1/ })).toHaveAttribute('aria-pressed', 'true');

  // place it by typing: across 10, down 20, width 30, height 10 (Tab applies each value and moves on)
  for (const v of ['10', '20', '30', '10']) { await page.keyboard.press('Control+A'); await page.keyboard.type(v); await page.keyboard.press('Tab'); }
  await expect(status).toContainText('Rectangle 1: at 10% across, 20% down, 30% wide, 10% tall.');

  // nudge from the list entry: Shift+Right twice = +10% across; Down five times = +5% down; Alt+Right ten times = +10% wider
  await panel.getByRole('button', { name: /^Rectangle 1/ }).focus();
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 10; i++) await page.keyboard.press('Alt+ArrowRight');
  await expect(status).toContainText('Rectangle 1 resized: at 20% across, 25% down, 40% wide, 10% tall.');
  await expect(page).toHaveURL(/\/edit/); // Alt+arrow must not have triggered the browser's back/forward
  await expect(panel.getByLabel('Across (%)')).toHaveValue('20');
  await expect(panel.getByLabel('Width (%)')).toHaveValue('40');

  // the edge of the page is respected and said aloud
  await panel.getByLabel('Across (%)').fill('95'); await page.keyboard.press('Enter');
  await expect(status).toContainText('at 60% across'); // held so the right edge stays on the page
  await panel.getByLabel('Across (%)').fill('20'); await page.keyboard.press('Enter');
  await expect(status).toContainText('at 20% across');

  // a second item, then delete it with the Delete key from its list entry: it goes, and the first is selected again
  await panel.getByLabel('What to add').selectOption('ellipse');
  await panel.getByRole('button', { name: 'Add to page 1' }).press('Enter');
  await expect(status).toContainText('Ellipse 1 added');
  await panel.getByRole('button', { name: /^Ellipse 1/ }).focus();
  await page.keyboard.press('Delete');
  await expect(status).toHaveText('Ellipse 1 removed.');
  await expect(panel.getByRole('button', { name: /^Ellipse/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Rectangle 1/ })).toHaveAttribute('aria-pressed', 'true');

  // save with the keyboard
  await page.getByRole('button', { name: 'Save PDF' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  const img = render((await dl.path())!);

  // independent check: Poppler's rendering of the saved file has a solid box at 20-60% across and 25-35% down, and nothing else
  const px = (fx: number, fy: number) => img.at(Math.round(fx * img.w), Math.round(fy * img.h));
  expect(dark(px(0.4, 0.3)), 'centre of the box').toBe(true);
  expect(dark(px(0.22, 0.26)) && dark(px(0.58, 0.34)), 'inside both corners').toBe(true);
  for (const [fx, fy, where] of [[0.1, 0.3, 'left of it'], [0.7, 0.3, 'right of it'], [0.4, 0.2, 'above it'], [0.4, 0.4, 'below it'], [0.05, 0.05, 'the far corner']] as const) {
    expect(white(px(fx, fy)), where).toBe(true);
  }
  expect(mon.problems).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});

test('redaction areas, text and the item list also work from the keyboard (and a screen reader gets names, states and announcements)', async ({ page }) => {
  await page.goto('/edit');
  await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(2)));
  await expect(page.getByRole('region', { name: 'Page canvas' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Keyboard and screen-reader controls' });
  const status = panel.getByRole('status');

  await panel.getByLabel('What to add').selectOption('text');
  await panel.getByRole('button', { name: 'Add to page 1' }).press('Enter');
  await expect(status).toContainText('Text 1 added to page 1');
  await panel.getByLabel('Text', { exact: true }).fill('Hello from the keyboard'); await page.keyboard.press('Enter');
  await expect(status).toContainText('Text 1 now reads “Hello from the keyboard”.');
  await expect(panel.getByRole('button', { name: /^Text 1/ })).toContainText('Hello from the keyboard');
  await panel.getByLabel('Text', { exact: true }).fill('   '); await page.keyboard.press('Enter');
  await expect(status).toContainText('Text cannot be empty'); // never leaves an item that the API would reject
  await expect(panel.getByLabel('Text', { exact: true })).toHaveValue('Hello from the keyboard');

  // items are per page, and the add button names the page
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(panel.getByRole('button', { name: 'Add to page 2' })).toBeVisible();
  await expect(panel).toContainText('Nothing on this page yet.');
  await expect(panel.getByRole('button', { name: /^Text 1/ })).toHaveCount(0);

  // not a number: refused politely
  await panel.getByRole('button', { name: 'Add to page 2' }).press('Enter');
  await panel.getByLabel('Across (%)').fill(''); await page.keyboard.press('Enter');
  await expect(status).toContainText('That is not a number');
  await axe(page, 'keyboard panel with an item');
});

test('in redaction mode the keyboard adds redaction areas only', async ({ page }) => {
  // Redaction is a paid tool: the seeded administrator (Business) has it.
  const { readState } = await import('../support/stack');
  const { login } = await import('../support/helpers');
  const st = readState();
  await login(page, st.adminEmail, st.adminPassword, '/redact');
  await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(1)));
  await expect(page.getByRole('region', { name: 'Page canvas' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Keyboard and screen-reader controls' });
  await expect(panel.getByLabel('What to add').locator('option')).toHaveText(['Redaction area']);
  await panel.getByRole('button', { name: 'Add to page 1' }).press('Enter');
  await expect(panel.getByRole('status')).toContainText('Redaction area 1 added to page 1');
  await page.getByRole('button', { name: 'Apply redactions' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 90_000 });
});
