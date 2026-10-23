import { test, expect } from '@playwright/test';
import { PDFDocument } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { file, makePdf, watchConsole } from '../support/helpers';

const text = (path: string, args: string[] = []) => execFileSync('pdftotext', [...args, path, '-']).toString();

test.describe('guest workflows (no account)', () => {
  test('homepage renders and offers tools; no console errors or CSP violations', async ({ page }) => {
    const mon = watchConsole(page);
    const res = await page.goto('/');
    expect(res!.headers()['content-security-policy']).toContain("script-src 'self'");
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every PDF Tool You Need. All in One Place.');
    await expect(page.getByRole('link', { name: 'Merge PDF' }).first()).toBeVisible();
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('merge: upload, reorder, process through the queue + separate worker, download, verify the PDF', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto('/merge');
    await page.setInputFiles('input[type=file]', [file('small.pdf', await makePdf(2, { w: 200, h: 200, label: 'A' })), file('big.pdf', await makePdf(3, { w: 300, h: 300, label: 'B' }))]);
    const items = page.getByRole('list', { name: 'Selected files' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await page.getByRole('button', { name: 'Move big.pdf up' }).click();
    await expect(items.first()).toContainText('big.pdf');
    await page.getByRole('button', { name: 'Merge PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect(dl.suggestedFilename()).toBe('merged.pdf');
    const doc = await PDFDocument.load(readFileSync(await dl.path()));
    expect(doc.getPages().map((p) => p.getWidth())).toEqual([300, 300, 300, 200, 200]); // reordered: big.pdf first
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('client-side validation: wrong type and empty files are explained, not sent', async ({ page }) => {
    await page.goto('/merge');
    await page.setInputFiles('input[type=file]', [file('notes.txt', Buffer.from('hello'), 'text/plain'), file('empty.pdf', Buffer.alloc(0))]);
    await expect(page.getByRole('alert')).toContainText('notes.txt');
    await expect(page.getByRole('alert')).toContainText('empty.pdf');
    await expect(page.getByRole('list', { name: 'Selected files' })).toHaveCount(0);
  });

  test('server-side validation: a PDF-named executable is rejected with a clear message', async ({ page }) => {
    await page.goto('/rotate');
    await page.setInputFiles('input[type=file]', file('evil.pdf', Buffer.from('MZ\x90\x00 not really a pdf')));
    await page.getByRole('button', { name: 'Rotate PDF' }).click();
    await expect(page.getByRole('alert')).toContainText(/not a supported file type/i);
  });

  test('organize: thumbnails render, duplicate/rotate/delete produce exactly that PDF', async ({ page }) => {
    await page.goto('/organize');
    await page.setInputFiles('input[type=file]', file('three.pdf', await makePdf(3, { label: 'P' })));
    await expect(page.getByText('3 pages in the result')).toBeVisible();
    // thumbnails are real renders (some dark text pixels), not blank canvases
    await expect.poll(() => page.locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 100) dark++;
      return dark;
    })).toBeGreaterThan(20);
    await page.getByRole('button', { name: 'Duplicate position 1' }).click();
    await page.getByRole('button', { name: 'Rotate position 2' }).click();
    await page.getByRole('button', { name: 'Delete position 4' }).click();
    await page.getByRole('button', { name: 'Reverse order' }).click();
    await page.getByRole('button', { name: 'Organize PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    const doc = await PDFDocument.load(readFileSync(path));
    // start [1,1(rot90),2,3] -> delete pos 4 -> [1,1r,2] -> reverse -> [2,1r,1]
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
    expect(text(path, ['-f', '1', '-l', '1'])).toContain('P page 2');
    expect(text(path, ['-f', '3', '-l', '3'])).toContain('P page 1');
  });

  test('edit: draw a rectangle and add text on the canvas; the saved PDF contains both', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto('/edit');
    await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(1, { label: 'Original' })));
    const svg = page.locator('svg.touch-none');
    await expect(svg).toBeVisible();
    await page.getByRole('button', { name: 'Fit to page' }).click(); // whole page on screen so pointer coordinates are real
    // Re-measure before every interaction: clicking toolbar buttons can scroll the page.
    const at = async (fx: number, fy: number) => { await svg.scrollIntoViewIfNeeded(); const b = (await svg.boundingBox())!; return { x: b.x + b.width * fx, y: b.y + b.height * fy }; };
    await page.getByRole('button', { name: 'Rectangle' }).click();
    const from = await at(0.1, 0.5), to = await at(0.6, 0.7);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
    await expect(page.getByText('1 item total')).toBeVisible();
    await page.getByRole('button', { name: 'Text' }).click();
    const t = await at(0.1, 0.1);
    await page.mouse.click(t.x, t.y);
    await page.getByLabel('Annotation text').fill('Reviewed by QA');
    await page.getByLabel('Annotation text').blur();
    await expect(page.getByText('2 items total')).toBeVisible();
    // typing a text box is a single history step: one Undo removes the whole box, no invisible leftovers
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('1 item total')).toBeVisible();
    await expect(page.getByText('Reviewed by QA')).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.getByText('2 items total')).toBeVisible();
    // double-click re-opens the text for editing
    await page.getByRole('button', { name: 'Select / move' }).click();
    const box = await at(0.12, 0.12);
    await page.mouse.dblclick(box.x, box.y);
    await page.getByLabel('Annotation text').fill('Reviewed by QA (final)');
    await page.getByLabel('Annotation text').blur();
    await expect(page.getByText('2 items total')).toBeVisible();
    await page.getByRole('button', { name: 'Save PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    expect(text(path).replace(/\s+/g, ' ')).toContain('Reviewed by QA (final)'); // the box wraps long text
    expect(text(path)).toContain('Original page 1'); // existing content preserved
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('premium tools tell guests exactly why they are blocked and where to go', async ({ page }) => {
    await page.goto('/redact');
    await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(1)));
    await page.getByRole('button', { name: 'Redact Area' }).click();
    await page.locator('svg.touch-none').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' })); // engines differ on whether hover() scrolls
    // The page is taller than the window and scrolls smoothly: wait for the scroll to settle, then drag inside the part that is on screen and below the sticky header.
    let box = (await page.locator('svg.touch-none').boundingBox())!;
    await expect.poll(async () => { const b = (await page.locator('svg.touch-none').boundingBox())!; const still = b.y === box.y; box = b; return still; }, { intervals: [150], timeout: 10_000 }).toBe(true);
    const top = Math.max(box.y, 0) + 140, left = box.x + 20;
    await page.mouse.move(left, top); await page.mouse.down(); await page.mouse.move(left + 100, top + 60, { steps: 4 }); await page.mouse.up();
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    await expect(page.getByRole('alert')).toContainText(/paid plan/i);
    await expect(page.getByRole('alert').getByRole('link', { name: 'See plans and limits' })).toHaveAttribute('href', '/pricing');
  });

  test('cancelling a running job from the UI stops it', async ({ page }) => {
    await page.goto('/pdf-to-images');
    await page.setInputFiles('input[type=file]', file('long.pdf', await makePdf(120)));
    await page.getByLabel('Resolution (DPI)').fill('300');
    await page.getByRole('button', { name: 'PDF to JPG / PNG' }).click();
    await expect(page.getByText(/Processing…|Waiting in queue…/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'PDF to JPG / PNG' })).toBeVisible({ timeout: 20_000 }); // back to the settings screen
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toHaveCount(0);
  });
});
