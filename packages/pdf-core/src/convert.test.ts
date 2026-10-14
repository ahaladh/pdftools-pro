import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
import { processTool, type InputFile } from './index.js';
import { colName, parseCell, rowsOf } from './convert.js';

let root: string;
let n = 0;

/** Two pages: a small table on page 1, a paragraph on page 2. Columns are separated by clear gaps. */
async function tablePdf(): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 300]);
  const rows = [['Item', 'Qty', 'Price'], ['Apple', '3', '1.50'], ['Pear', '1,200', '2.25'], ['Code', '007', 'A & B <x>']];
  rows.forEach((r, i) => r.forEach((c, j) => p1.drawText(c, { x: 20 + j * 120, y: 250 - i * 20, size: 12, font })));
  const p2 = doc.addPage([400, 300]);
  p2.drawText('Second page narrative', { x: 20, y: 250, size: 12, font });
  const path = join(root, 'table.pdf');
  await writeFile(path, await doc.save());
  return { path, name: 'table.pdf', kind: 'pdf' };
}
async function blankPdf(): Promise<InputFile> {
  const doc = await PDFDocument.create(); doc.addPage([200, 200]);
  const path = join(root, 'blank.pdf'); await writeFile(path, await doc.save());
  return { path, name: 'blank.pdf', kind: 'pdf' };
}
async function run(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown = {}) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool(tool, { workDir, inputs, options, timeoutMs: 120_000, maxPages: 50 });
}

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'conv-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('cell helpers', () => {
  it('names columns like a spreadsheet', () => {
    expect([0, 25, 26, 27, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
  it('only plain numbers become numeric; ids, dates and currency stay text', () => {
    expect(parseCell('1,200')).toEqual({ n: 1200 });
    expect(parseCell('-3.5')).toEqual({ n: -3.5 });
    for (const t of ['007', '2024-01-05', '$5.00', '+1 555 0100', '12345678901234567890', '1.2.3', '']) expect(parseCell(t)).toEqual({ s: t.trim() });
  });
  it('splits on gaps of two or more spaces and skips blank lines', () => {
    expect(rowsOf('a  b   c\n\n   \nsingle word here\n')).toEqual([['a', 'b', 'c'], ['single word here']]);
  });
});

describe('PDF -> Excel', () => {
  it('writes one sheet per page that LibreOffice opens, with numbers typed and text preserved', async () => {
    const r = await run('pdf-to-excel', [await tablePdf()]);
    expect(r.name).toBe('table.xlsx');
    expect(r.stats).toMatchObject({ pages: 2 });
    const z = unzipSync(new Uint8Array(readFileSync(r.path)));
    expect(Object.keys(z)).toEqual(expect.arrayContaining(['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    const s1 = strFromU8(z['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('<v>1200</v>');            // "1,200" -> number
    expect(s1).toContain('>007<');                   // leading zeros kept as text
    expect(s1).toContain('A &amp; B &lt;x&gt;');     // escaped, not interpreted
    // Independent reader: a real spreadsheet engine must open it and see the same grid.
    const dir = join(root, `lo${n++}`); await mkdir(dir);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'csv', '--outdir', dir, r.path], { stdio: 'ignore', timeout: 120_000 });
    const csv = readFileSync(join(dir, basename(r.path, extname(r.path)) + '.csv'), 'utf8');
    expect(csv).toContain('Item,Qty,Price');
    expect(csv).toContain('Pear,1200,2.25');
    expect(csv).toContain('Code,007,A & B <x>');
  });
  it('refuses a PDF with no text rather than returning an empty workbook', async () => {
    await expect(run('pdf-to-excel', [await blankPdf()])).rejects.toMatchObject({ code: 'no_text' });
  });
  it('rejects unexpected options', async () => {
    await expect(run('pdf-to-excel', [await tablePdf()], { x: 1 })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('PDF -> Word / PowerPoint', () => {
  it('Word: a DOCX that contains the page text and re-renders to PDF', async () => {
    const r = await run('pdf-to-word', [await tablePdf()]);
    expect(r.name).toBe('table.docx');
    const z = unzipSync(new Uint8Array(readFileSync(r.path)));
    const xml = strFromU8(z['word/document.xml']!);
    expect(xml).toContain('Apple');
    expect(xml).toContain('Second page narrative');
    const dir = join(root, `lo${n++}`); await mkdir(dir);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'pdf', '--outdir', dir, r.path], { stdio: 'ignore', timeout: 120_000 });
    expect(execFileSync('pdftotext', [join(dir, basename(r.path, extname(r.path)) + '.pdf'), '-']).toString()).toContain('Pear');
  });
  it('PowerPoint: one slide per page holding that page\'s text', async () => {
    const r = await run('pdf-to-powerpoint', [await tablePdf()]);
    const z = unzipSync(new Uint8Array(readFileSync(r.path)));
    const slides = Object.keys(z).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slides).toHaveLength(2);
    expect(strFromU8(z['ppt/slides/slide1.xml']!)).toContain('Apple');
    expect(strFromU8(z['ppt/slides/slide2.xml']!)).toContain('Second page narrative');
  });
  it('warns when the PDF has no text layer', async () => {
    const r = await run('pdf-to-word', [await blankPdf()]);
    expect(r.warnings.join(' ')).toMatch(/No text layer/);
  });
  it('rejects a damaged PDF with a clean error', async () => {
    const p = join(root, 'bad.pdf'); await writeFile(p, 'not a pdf');
    await expect(run('pdf-to-word', [{ path: p, name: 'bad.pdf', kind: 'pdf' }])).rejects.toMatchObject({ code: 'invalid_pdf' });
  });
});
