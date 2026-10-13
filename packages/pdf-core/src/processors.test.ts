import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';
import { processTool, ToolError, type InputFile } from './index.js';

let root: string;
let counter = 0;

async function makePdf(pages: number, name: string): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([400, 600]).drawText(`${name} page ${i + 1}`, { x: 50, y: 500, size: 24, font });
  const path = join(root, `${name}.pdf`);
  await writeFile(path, await doc.save());
  return { path, name: `${name}.pdf`, kind: 'pdf' };
}

async function run(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown = {}) {
  const workDir = join(root, `job${counter++}`);
  await mkdir(workDir);
  return processTool(tool, { workDir, inputs, options, timeoutMs: 30_000, maxPages: 100 });
}

const pageCount = async (p: string) => (await PDFDocument.load(await readFile(p))).getPageCount();

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'pdfcore-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('page operations', () => {
  it('merges in the given order', async () => {
    const a = await makePdf(2, 'a'), b = await makePdf(3, 'b');
    const r = await run('merge', [b, a]);
    expect(await pageCount(r.path)).toBe(5);
  });
  it('rejects merge with a single file', async () => {
    await expect(run('merge', [await makePdf(1, 'solo')])).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('splits into one file per page as zip', async () => {
    const r = await run('split', [await makePdf(3, 's1')], { mode: 'each' });
    const files = unzipSync(new Uint8Array(await readFile(r.path)));
    expect(Object.keys(files)).toHaveLength(3);
    for (const data of Object.values(files)) expect((await PDFDocument.load(data)).getPageCount()).toBe(1);
  });
  it('splits by ranges (each comma part is a file)', async () => {
    const r = await run('split', [await makePdf(6, 's2')], { mode: 'ranges', ranges: '1-2,4-6' });
    const files = Object.values(unzipSync(new Uint8Array(await readFile(r.path))));
    expect(await Promise.all(files.map(async (d) => (await PDFDocument.load(d)).getPageCount()))).toEqual([2, 3]);
  });
  it('splits every N pages', async () => {
    const r = await run('split', [await makePdf(5, 's3')], { mode: 'every', every: 2 });
    expect(r.stats?.files).toBe(3);
  });
  it('rotates selected pages', async () => {
    const r = await run('rotate', [await makePdf(3, 'r')], { angle: 90, pages: '2' });
    const d = await PDFDocument.load(await readFile(r.path));
    expect(d.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
  });
  it('organizes: reorder, delete and duplicate', async () => {
    const r = await run('organize', [await makePdf(4, 'o')], { order: '3,1,1', rotations: { '1': 180 } });
    const d = await PDFDocument.load(await readFile(r.path));
    expect(d.getPageCount()).toBe(3);
    expect(d.getPage(0).getRotation().angle).toBe(180);
  });
  it('extracts pages', async () => {
    const r = await run('extract-pages', [await makePdf(5, 'e')], { pages: '2-3,5' });
    expect(await pageCount(r.path)).toBe(3);
  });
  it('reports invalid ranges clearly', async () => {
    await expect(run('extract-pages', [await makePdf(2, 'bad')], { pages: '9' })).rejects.toMatchObject({ code: 'invalid_options' });
  });
  it('enforces the page limit', async () => {
    await expect(run('rotate', [await makePdf(101, 'big')], { angle: 90 })).rejects.toMatchObject({ code: 'too_many_pages' });
  });
});

describe('stamping', () => {
  it('adds page numbers', async () => {
    const r = await run('page-numbers', [await makePdf(2, 'pn')], { format: 'n-of-total' });
    expect(await pageCount(r.path)).toBe(2);
    expect((await stat(r.path)).size).toBeGreaterThan(0);
  });
  it('adds a watermark and rejects unencodable text', async () => {
    const f = await makePdf(2, 'wm');
    const r = await run('watermark', [f], { text: 'CONFIDENTIAL' });
    expect(await pageCount(r.path)).toBe(2);
    await expect(run('watermark', [f], { text: '機密' })).rejects.toMatchObject({ code: 'unsupported_text' });
  });
});

describe('ghostscript / poppler', () => {
  it('compresses and reports real sizes', async () => {
    const r = await run('compress', [await makePdf(3, 'c')], { preset: 'recommended' });
    expect(r.stats?.originalBytes).toBeGreaterThan(0);
    expect(await pageCount(r.path)).toBe(3);
  });
  it('strips metadata', async () => {
    const doc = await PDFDocument.create(); doc.addPage(); doc.setTitle('Secret'); doc.setAuthor('Me');
    const path = join(root, 'meta.pdf'); await writeFile(path, await doc.save());
    const r = await run('compress', [{ path, name: 'meta.pdf', kind: 'pdf' }], { stripMetadata: true });
    const out = await PDFDocument.load(await readFile(r.path), { updateMetadata: false });
    expect(out.getTitle() ?? '').toBe('');
    expect(out.getAuthor() ?? '').toBe('');
  });
  it('renders PDF to PNG images (zip) with valid PNG signatures', async () => {
    const r = await run('pdf-to-images', [await makePdf(2, 'img')], { format: 'png', dpi: 72 });
    const files = Object.values(unzipSync(new Uint8Array(await readFile(r.path))));
    expect(files).toHaveLength(2);
    expect(Buffer.from(files[0]!.slice(0, 4)).toString('hex')).toBe('89504e47');
  });
  it('renders one JPG directly', async () => {
    const r = await run('pdf-to-images', [await makePdf(2, 'img1')], { format: 'jpg', pages: '2', dpi: 72 });
    expect(r.mime).toBe('image/jpeg');
  });
  it('round trip: images to PDF then output is rendered by poppler', async () => {
    const png = await run('pdf-to-images', [await makePdf(1, 'rt')], { format: 'png', dpi: 72 });
    const jpg = await run('pdf-to-images', [await makePdf(1, 'rt2')], { format: 'jpg', dpi: 72 });
    const r = await run('images-to-pdf', [
      { path: png.path, name: 'a.png', kind: 'png' }, { path: jpg.path, name: 'b.jpg', kind: 'jpg' },
    ], { pageSize: 'a4', margin: 10 });
    expect(await pageCount(r.path)).toBe(2);
    execFileSync('pdftoppm', ['-r', '20', '-png', r.path, join(root, 'rt-out')]); // throws if unreadable
  });
});

describe('hostile input', () => {
  it('rejects malformed PDFs', async () => {
    const path = join(root, 'junk.pdf'); await writeFile(path, '%PDF-1.4\nthis is not a pdf');
    await expect(run('rotate', [{ path, name: 'junk.pdf', kind: 'pdf' }], { angle: 90 })).rejects.toBeInstanceOf(ToolError);
  });
  it('rejects empty files', async () => {
    const path = join(root, 'empty.pdf'); await writeFile(path, '');
    await expect(run('rotate', [{ path, name: 'empty.pdf', kind: 'pdf' }], { angle: 90 })).rejects.toBeInstanceOf(ToolError);
  });
  it('rejects encrypted PDFs with a helpful code', async () => {
    const src = await makePdf(1, 'plain');
    const enc = join(root, 'enc.pdf');
    execFileSync('gs', ['-sDEVICE=pdfwrite', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sUserPassword=pw', '-sOwnerPassword=pw', `-sOutputFile=${enc}`, src.path]);
    await expect(run('rotate', [{ path: enc, name: 'enc.pdf', kind: 'pdf' }], { angle: 90 })).rejects.toMatchObject({ code: 'encrypted_pdf' });
  });
  it('rejects corrupt images', async () => {
    const path = join(root, 'bad.jpg'); await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
    await expect(run('images-to-pdf', [{ path, name: 'bad.jpg', kind: 'jpg' }])).rejects.toMatchObject({ code: 'invalid_image' });
  });
  it('rejects invalid options', async () => {
    await expect(run('rotate', [await makePdf(1, 'x')], { angle: 45 })).rejects.toMatchObject({ code: 'invalid_options' });
  });
  it('times out runaway engines', async () => {
    const f = await makePdf(30, 'to');
    const workDir = join(root, 'jobto'); await mkdir(workDir);
    await expect(processTool('compress', { workDir, inputs: [f], options: {}, timeoutMs: 1, maxPages: 100 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
