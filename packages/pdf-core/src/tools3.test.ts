import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { processTool, type InputFile } from './index.js';

let root: string;
let n = 0;

async function pdfWith(name: string, rotation = 0, text = 'Hello'): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText(text, { x: 20, y: 150, size: 18, font });
  page.setRotation(degrees(rotation));
  const path = join(root, `${name}.pdf`);
  await writeFile(path, await doc.save());
  return { path, name: `${name}.pdf`, kind: 'pdf' };
}
async function run(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool(tool, { workDir, inputs, options, timeoutMs: 60_000, maxPages: 50 });
}
/** Render page 1 at 72dpi and return the pixel colour at display coords (px,py). */
function pixel(pdf: string, px: number, py: number): string {
  const stem = join(root, `r${n++}`);
  execFileSync('pdftoppm', ['-r', '72', '-png', '-singlefile', pdf, stem]);
  return execFileSync('convert', [`${stem}.png`, '-format', `%[pixel:p{${px},${py}}]`, 'info:']).toString().replace(/\s/g, '');
}
const isRed = (c: string) => /^(srgb\(2[45]\d,\d{1,2},\d{1,2}\)|red)/.test(c);
const isWhite = (c: string) => /^(srgb\(25[0-5],25[0-5],25[0-5]\)|white)/.test(c);

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'core3-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('annotate: placement is correct on every page rotation', () => {
  // Asymmetric on purpose: a mirrored/transposed mapping must put colour where we assert emptiness.
  const dims = (rot: number) => (rot % 180 ? [200, 400] : [400, 200]) as [number, number];
  const at = (r: string, f: [number, number], rot: number) => { const [w, h] = dims(rot); return pixel(r, Math.round(f[0] * w), Math.round(f[1] * h)); };
  for (const rot of [0, 90, 180, 270]) {
    it(`rectangle at the right visual spot with /Rotate ${rot}`, async () => {
      const f = await pdfWith(`rect${rot}`, rot);
      const r = await run('edit', [f], { annotations: [{ type: 'rect', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.3, stroke: null, fill: '#ff0000', strokeWidth: 0, opacity: 1 }] });
      expect(isRed(at(r.path, [0.2, 0.25], rot))).toBe(true);
      for (const wrong of [[0.8, 0.25], [0.2, 0.75], [0.8, 0.75], [0.45, 0.25]] as [number, number][]) expect(isWhite(at(r.path, wrong, rot))).toBe(true);
    });
    it(`ellipse is placed correctly with /Rotate ${rot}`, async () => {
      const f = await pdfWith(`ell${rot}`, rot);
      const r = await run('edit', [f], { annotations: [{ type: 'ellipse', page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.4, stroke: null, fill: '#ff0000', strokeWidth: 0, opacity: 1 }] });
      expect(isRed(at(r.path, [0.25, 0.3], rot))).toBe(true);
      for (const wrong of [[0.75, 0.3], [0.25, 0.7], [0.75, 0.7], [0.11, 0.11]] as [number, number][]) expect(isWhite(at(r.path, wrong, rot))).toBe(true);
    });
  }
  it('text is upright and extractable on a rotated page', async () => {
    const f = await pdfWith('txt90', 90, 'base');
    const r = await run('edit', [f], { annotations: [{ type: 'text', page: 0, x: 0.1, y: 0.1, w: 0.6, h: 0.1, text: 'ANNOTATED', fontSize: 14, color: '#000000', font: 'helvetica' }] });
    expect(execFileSync('pdftotext', [r.path, '-']).toString()).toContain('ANNOTATED');
  });
  it('draws lines, freehand, highlight and images without error', async () => {
    const f = await pdfWith('mix');
    const png = join(root, 'src.png');
    execFileSync('pdftoppm', ['-r', '20', '-png', '-singlefile', f.path, png.replace(/\.png$/, '')]);
    const r = await run('edit', [f, { path: png, name: 'sig.png', kind: 'png' }], { annotations: [
      { type: 'line', page: 0, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9, color: '#0000ff', strokeWidth: 3, opacity: 1 },
      { type: 'draw', page: 0, points: [[0.1, 0.5], [0.2, 0.6], [0.3, 0.5]], color: '#00aa00', strokeWidth: 2, opacity: 1 },
      { type: 'highlight', page: 0, x: 0.05, y: 0.05, w: 0.3, h: 0.1, color: '#ffff00', opacity: 0.4 },
      { type: 'image', page: 0, x: 0.6, y: 0.1, w: 0.3, h: 0.3, imageIndex: 0, opacity: 1 },
    ] });
    expect((await PDFDocument.load(await readFile(r.path))).getPageCount()).toBe(1);
  });
  it('leaves the uploaded original untouched', async () => {
    const f = await pdfWith('orig');
    const before = await readFile(f.path);
    await run('edit', [f], { annotations: [{ type: 'rect', page: 0, x: 0, y: 0, w: 0.1, h: 0.1, stroke: '#000000', fill: null, strokeWidth: 1, opacity: 1 }] });
    expect((await readFile(f.path)).equals(before)).toBe(true);
  });
  it('validates input', async () => {
    const f = await pdfWith('val');
    const rect = { type: 'rect', x: 0, y: 0, w: 0.1, h: 0.1, stroke: null, fill: '#000000', strokeWidth: 0, opacity: 1 };
    await expect(run('edit', [f], { annotations: [{ ...rect, page: 5 }] })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('edit', [f], { annotations: [] })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('edit', [f], { annotations: [{ ...rect, page: 0, x: 3 }] })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('edit', [f], { annotations: [{ type: 'image', page: 0, x: 0, y: 0, w: 0.1, h: 0.1, imageIndex: 0, opacity: 1 }] })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('edit', [f], { annotations: [{ type: 'text', page: 0, x: 0, y: 0, w: 0.5, h: 0.1, text: '日本', fontSize: 12, color: '#000000', font: 'helvetica' }] })).rejects.toMatchObject({ code: 'unsupported_text' });
  });
  it('sign: warns that the signature is visual only', async () => {
    const f = await pdfWith('sg');
    const r = await run('sign', [f], { annotations: [{ type: 'rect', page: 0, x: 0, y: 0, w: 0.1, h: 0.1, stroke: '#000000', fill: null, strokeWidth: 1, opacity: 1 }] });
    expect(r.warnings.join()).toMatch(/not a certificate-based/);
  });
});

describe('redact: content is actually removed', () => {
  async function twoPage(): Promise<InputFile> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.setTitle('TOPSECRET-TITLE');
    const p1 = doc.addPage([400, 200]); p1.drawText('SECRETNUMBER 1234-5678', { x: 20, y: 150, size: 20, font });
    const p2 = doc.addPage([400, 200]); p2.drawText('PUBLICPAGE stays selectable', { x: 20, y: 150, size: 20, font });
    const path = join(root, 'two.pdf'); await writeFile(path, await doc.save());
    return { path, name: 'two.pdf', kind: 'pdf' };
  }
  it('removes the covered text from the file bytes and text layer, keeps other pages', async () => {
    const f = await twoPage();
    // text spans roughly y=30..50 of 200 (fraction 0.15..0.27) across x 0.05..0.75
    const r = await run('redact', [f], { redactions: [{ page: 0, x: 0.03, y: 0.1, w: 0.8, h: 0.25 }], dpi: 100 });
    const bytes = (await readFile(r.path)).toString('latin1');
    expect(bytes).not.toContain('SECRETNUMBER');
    expect(bytes).not.toContain('TOPSECRET-TITLE');
    const text = execFileSync('pdftotext', [r.path, '-']).toString();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('1234');
    expect(text).toContain('PUBLICPAGE');
    expect(r.stats?.pagesRedacted).toBe(1);
    // the area is black in the rendered output
    expect(pixel(r.path, 100, 35)).toMatch(/^(black|srgb\(0,0,0\))/);
  });
  it('is not just a black box: the image under the box is burned (no recoverable pixels)', async () => {
    const f = await twoPage();
    const r = await run('redact', [f], { redactions: [{ page: 0, x: 0, y: 0, w: 1, h: 1 }], dpi: 72 });
    const stem = join(root, 'full');
    execFileSync('pdftoppm', ['-r', '72', '-f', '1', '-l', '1', '-png', '-singlefile', r.path, stem]);
    // every pixel black => mean intensity 0
    const mean = execFileSync('convert', [`${stem}.png`, '-format', '%[fx:mean]', 'info:']).toString();
    expect(Number(mean)).toBe(0);
  });
  it('validates redactions', async () => {
    const f = await twoPage();
    await expect(run('redact', [f], { redactions: [] })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('redact', [f], { redactions: [{ page: 9, x: 0, y: 0, w: 0.1, h: 0.1 }] })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});
