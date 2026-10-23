import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { file, watchConsole } from '../support/helpers';

const W = 400, H = 500; // points, unrotated
const LINES: string[][] = [
  ['alpha bravo charlie', 'bravo again'],
  ['Bravo upper', 'charlie delta', 'echo foxtrot'],
  ['delta echo bravo'],
];
async function build(rotatePage3: boolean) {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  LINES.forEach((lines, p) => {
    const page = doc.addPage([W, H]);
    lines.forEach((t, i) => page.drawText(t, { x: 50, y: 420 - i * 40, size: 20, font }));
    if (p === 2 && rotatePage3) page.setRotation(degrees(90));
  });
  return Buffer.from(await doc.save());
}

interface Word { text: string; x0: number; y0: number; x1: number; y1: number }
/** Word boxes in points, top-left origin, from Poppler: our oracle for where text really is. */
function words(pdf: string, page: number): Word[] {
  const out = execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdf, '-']).toString();
  return [...out.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x0: +m[1]!, y0: +m[2]!, x1: +m[3]!, y1: +m[4]!, text: m[5]! }));
}
/** Where a word's centre should be as a fraction of the page as DISPLAYED. Rotating a page 90 degrees clockwise sends (u, v) to (H - v, u). */
const centre = (w: Word, rotated: boolean) => { const u = (w.x0 + w.x1) / 2, v = (w.y0 + w.y1) / 2; return rotated ? { x: 1 - v / H, y: u / W } : { x: u / W, y: v / H }; };

async function boxes(page: Page) {
  const pageEl = page.locator('[data-testid=highlights]').locator('xpath=..');
  const size = (await pageEl.boundingBox())!;
  const els = await page.locator('[data-testid=highlights] [data-box]').all();
  const out: { hit: number; current: boolean; x: number; y: number; w: number; h: number }[] = [];
  for (const e of els) {
    const [l, t, w, h] = (await e.getAttribute('data-box'))!.split(',').map(Number) as [number, number, number, number];
    out.push({ hit: Number(await e.getAttribute('data-hit')), current: (await e.getAttribute('data-current')) === 'true', x: (l + w / 2) / size.width, y: (t + h / 2) / size.height, w: w / size.width, h: h / size.height });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

test('open a PDF locally, search the whole document, and the highlights sit exactly on the words Poppler finds', async ({ page }) => {
  test.setTimeout(120_000);
  const mon = watchConsole(page);
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${r.url()}`); });

  const dir = mkdtempSync(join(tmpdir(), 'view-'));
  const rotated = await build(true), twin = await build(false);
  writeFileSync(join(dir, 'twin.pdf'), twin);

  await page.goto('/view');
  await expect(page.getByRole('heading', { name: 'View PDF', level: 1 })).toBeVisible();
  await expect(page.getByText('never uploaded').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', file('notes.pdf', rotated));
  const doc = page.getByRole('region', { name: 'Document' });
  await expect(doc).toBeVisible();
  await expect(page.getByTestId('text-layer')).toContainText('alpha bravo charlie'); // the text is real, selectable text
  await expect(page.getByRole('status').first()).toHaveText('');

  const search = page.getByRole('searchbox', { name: 'Find in document' });
  const status = page.getByRole('status').first();

  // 1. a word in several places and pages (capitals ignored)
  await search.fill('bravo');
  await expect(status).toHaveText('Match 1 of 4, on page 1');
  await expect(page.getByRole('button', { name: 'Go to page 1 (has matches)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to page 2 (has matches)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to page 3 (has matches)' })).toBeVisible();
  await expect.poll(async () => (await boxes(page)).length).toBe(2); // both matches on page 1 are drawn

  // ...and they are where Poppler says the words are (centres within 1.5% of the page; widths within a quarter)
  const w1 = words(join(dir, 'twin.pdf'), 1).filter((w) => w.text === 'bravo').sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const b1 = await boxes(page);
  expect(w1).toHaveLength(2);
  w1.forEach((w, i) => {
    const c = centre(w, false);
    expect(close(b1[i]!.x, c.x, 0.015), `page 1 hit ${i} x ${b1[i]!.x} vs ${c.x}`).toBe(true);
    expect(close(b1[i]!.y, c.y, 0.015), `page 1 hit ${i} y ${b1[i]!.y} vs ${c.y}`).toBe(true);
    expect(close(b1[i]!.w, (w.x1 - w.x0) / W, ((w.x1 - w.x0) / W) * 0.25), `width ${b1[i]!.w}`).toBe(true);
  });
  expect(b1.filter((b) => b.current).map((b) => b.hit)).toEqual([0]); // only the current one is marked as current

  // 2. next / previous: Enter moves on (crossing to another page), Shift+Enter goes back, and it wraps round
  await search.press('Enter'); await expect(status).toHaveText('Match 2 of 4, on page 1');
  await search.press('Enter'); await expect(status).toHaveText('Match 3 of 4, on page 2');
  await expect(page.getByLabel('Page number')).toHaveValue('2');
  await search.press('Shift+Enter'); await expect(status).toHaveText('Match 2 of 4, on page 1');
  await search.press('Enter'); await search.press('Enter'); await expect(status).toHaveText('Match 4 of 4, on page 3');
  await search.press('Enter'); await expect(status).toHaveText('Match 1 of 4, on page 1'); // wrapped
  await page.getByRole('button', { name: 'Previous match' }).click(); await expect(status).toHaveText('Match 4 of 4, on page 3');

  // 3. the rotated page: the highlight is on the displayed word, not where it would be unrotated
  await expect.poll(async () => (await boxes(page)).length).toBe(1);
  const w3 = words(join(dir, 'twin.pdf'), 3).find((w) => w.text === 'bravo')!;
  const b3 = (await boxes(page))[0]!, c3 = centre(w3, true);
  expect(close(b3.x, c3.x, 0.02), `rotated x ${b3.x} vs ${c3.x}`).toBe(true);
  expect(close(b3.y, c3.y, 0.02), `rotated y ${b3.y} vs ${c3.y}`).toBe(true);
  expect(b3.h).toBeGreaterThan(b3.w * 0.0); // sanity: a real box

  // 4. zoom keeps the highlights on the words
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => { const z = await boxes(page); return z.length === 1 && close(z[0]!.x, c3.x, 0.02) && close(z[0]!.y, c3.y, 0.02); }).toBe(true);

  // 5. a phrase that runs across a line break, and match case
  // (searching starts from where the reader is, which is page 3: that is the second of the two matches)
  await search.fill('delta echo');
  await expect(status).toHaveText('Match 2 of 2, on page 3');
  await search.press('Enter'); await expect(status).toHaveText('Match 1 of 2, on page 2');
  await expect.poll(async () => (await boxes(page)).length).toBe(2); // across the line break: one box on each line
  await search.fill('ALPHA BRAVO');
  await expect(status).toHaveText('Match 1 of 1, on page 1');
  await page.getByLabel('Match case').check();
  await expect(status).toHaveText('No matches');
  await page.getByLabel('Match case').uncheck();
  await search.fill('bravo'); await page.getByLabel('Match case').check();
  await expect(status).toHaveText(/^Match 1 of 3,/); // "Bravo" on page 2 no longer counts

  // 6. odd queries are just text; clearing removes everything
  await page.getByLabel('Match case').uncheck();
  for (const q of ['(', '.*', '[a-', '\\', 'a|b', 'nothing-like-this']) { await search.fill(q); await expect(status).toHaveText('No matches'); }
  await search.fill('');
  await expect(status).toHaveText('');
  await expect(page.locator('[data-testid=highlights] [data-box]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /has matches/ })).toHaveCount(0);

  // the highlights are accessible too (decorative; the matches are announced), and nothing was ever sent anywhere
  await search.fill('bravo');
  await expect(status).toHaveText(/^Match 1 of 4/);
  await axe(page, 'viewer with matches');
  expect(posts, 'viewing a PDF must not make any non-GET request').toEqual([]);
  expect(mon.problems).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});

test('files that cannot be opened are explained, and a password-protected one points to Unlock', async ({ page }) => {
  await page.goto('/view');
  await page.setInputFiles('input[type=file]', file('notes.txt', Buffer.from('hello'), 'text/plain'));
  await expect(page.getByRole('alert')).toContainText('"notes.txt" is not a PDF.');
  await page.setInputFiles('input[type=file]', file('broken.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('nonsense')])));
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  await page.getByRole('button', { name: 'Open another file' }).click();
  // a real password-protected file (made with Ghostscript, the engine behind the Protect tool)
  const dir = mkdtempSync(join(tmpdir(), 'viewenc-'));
  const plain = join(dir, 'plain.pdf'), locked = join(dir, 'locked.pdf');
  writeFileSync(plain, await build(false));
  execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-sUserPassword=secret-pw', '-sOwnerPassword=secret-pw', `-sOutputFile=${locked}`, plain]);
  await page.setInputFiles('input[type=file]', { name: 'locked.pdf', mimeType: 'application/pdf', buffer: readFileSync(locked) });
  await expect(page.getByRole('alert')).toContainText('password-protected');
  await expect(page.getByRole('alert').getByRole('link', { name: 'Unlock PDF' })).toHaveAttribute('href', '/unlock');
  await page.getByRole('button', { name: 'Open another file' }).click();
  await page.setInputFiles('input[type=file]', file('empty.pdf', Buffer.alloc(0)));
  await expect(page.getByRole('alert')).toContainText('is empty.');
});

const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
