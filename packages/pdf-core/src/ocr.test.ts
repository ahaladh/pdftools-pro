import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { processTool, type InputFile } from './index.js';
import { parseBBox } from './search.js';
import { parseTsv } from './ocr.js';
import { engineEnv } from './exec.js';

// These tests start real engines (LibreOffice, a JVM, Tesseract): seconds each even when idle, far more under load.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Tesseract is an optional engine. Locally these tests skip LOUDLY without it; in CI a missing engine is a hard failure.
const have = (() => { try { execFileSync('tesseract', ['--version'], { stdio: 'ignore', env: engineEnv(tmpdir()) }); return true; } catch { return false; } })();
if (!have) {
  if (process.env.CI) throw new Error('tesseract is required in CI');
  console.warn('\n⚠ OCR tests SKIPPED: tesseract is not installed (or PDFTOOLS_BIN_DIR/TESSDATA_PREFIX/LD_LIBRARY_PATH are not set).\n');
}

let root: string;
let n = 0;
const pdfIn = (path: string, name = 'in.pdf'): InputFile => ({ path, name, kind: 'pdf' });
async function run(inputs: InputFile[], options: unknown = {}) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool('ocr', { workDir, inputs, options, timeoutMs: 180_000, maxPages: 50 });
}
const text = (pdf: string, page = 1) => execFileSync('pdftotext', ['-f', String(page), '-l', String(page), pdf, '-']).toString().replace(/\s+/g, ' ').trim();

/** A page that is only a picture of text, like a scan (300 dpi). */
async function scan(name: string, lines: string[], rotation = 0): Promise<InputFile> {
  const img = join(root, `${name}.png`);
  const draw = lines.flatMap((l, i) => ['-annotate', `+60+${130 + i * 150}`, l]);
  execFileSync('convert', ['-size', '1500x600', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '64', '-fill', 'black', ...draw, '-colorspace', 'Gray',
    // A scan shown with /Rotate is stored sideways so that it DISPLAYS upright: pre-rotate the picture the opposite way.
    ...(rotation ? ['-rotate', String(-rotation)] : []), `png:${img}`]);
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(await readFile(img));
  const [pw, ph] = rotation % 180 ? [144, 360] : [360, 144]; // 1500x600 px at 300 dpi = 360x144 pt
  const p = doc.addPage([pw, ph]);
  p.drawImage(png, { x: 0, y: 0, width: pw, height: ph });
  p.setRotation(degrees(rotation));
  const path = join(root, `${name}.pdf`); await writeFile(path, await doc.save());
  return pdfIn(path, `${name}.pdf`);
}
const render = (pdf: string, dpi = 72) => { const s = join(root, `r${n++}`); execFileSync('pdftoppm', ['-r', String(dpi), '-png', '-singlefile', pdf, s]); return `${s}.png`; };
/** Bounding box of non-white content in the rendered page: [x0,y0,x1,y1] in points. */
function inkBox(pdf: string): [number, number, number, number] {
  const out = execFileSync('convert', [render(pdf), '-fuzz', '30%', '-trim', '-format', '%w %h %X %Y', 'info:']).toString().trim().split(/\s+/);
  const [w, h, x, y] = [out[0], out[1], out[2]!.replace('+', ''), out[3]!.replace('+', '')].map(Number) as [number, number, number, number];
  return [x, y, x + w, y + h];
}

describe.skipIf(!have)('OCR', () => {
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'ocr-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('makes a scanned page searchable', async () => {
    const f = await scan('s1', ['Hello OCR world', 'Invoice 12345 total']);
    expect(text(f.path)).toBe(''); // really is just a picture
    const r = await run([f]);
    const t = text(r.path);
    expect(t).toContain('Hello OCR world'); expect(t).toContain('Invoice 12345 total');
    expect(r.stats).toMatchObject({ pagesRecognised: 1, pagesSkipped: 0 });
    expect(Number(r.stats!.words)).toBeGreaterThanOrEqual(6);
    expect(Number(r.stats!.meanConfidence)).toBeGreaterThanOrEqual(80);
  });

  it('pixels are identical before and after', async () => {
    const f = await scan('s3', ['Hello OCR world']);
    const r = await run([f]);
    let ae = '';
    try { execFileSync('compare', ['-metric', 'AE', render(f.path, 100), render(r.path, 100), 'null:'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { ae = String((e as { stderr: Buffer }).stderr); }
    // `compare` exits 1 when images differ and prints the differing-pixel count on stderr; exit 0 means identical
    expect(ae).toBe('');
  });

  for (const rot of [0, 90, 180, 270]) {
    it(`the text layer sits on the printed words (page /Rotate ${rot})`, async () => {
      const f = await scan(`al${rot}`, ['Hello OCR world', 'Invoice 12345 total'], rot);
      const r = await run([f]);
      expect(text(r.path)).toContain('Hello OCR world');
      const pg = parseBBox(execFileSync('pdftotext', ['-bbox', r.path, '-']).toString())[0]!;
      expect(pg.words.length).toBeGreaterThanOrEqual(6);
      const x0 = Math.min(...pg.words.map((w) => w.x0)), y0 = Math.min(...pg.words.map((w) => w.y0)), x1 = Math.max(...pg.words.map((w) => w.x1)), y1 = Math.max(...pg.words.map((w) => w.y1));
      const ink = inkBox(f.path);
      const tol = 9; // points
      expect(Math.abs(x0 - ink[0]), 'left').toBeLessThan(tol); expect(Math.abs(x1 - ink[2]), 'right').toBeLessThan(tol);
      expect(Math.abs(y0 - ink[1]), 'top').toBeLessThan(tol); expect(Math.abs(y1 - ink[3]), 'bottom').toBeLessThan(tol);
    });
  }

  it('leaves pages that already have text alone and recognises the rest', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([360, 144]).drawText('Born digital page', { x: 20, y: 70, size: 14, font });
    const scanDoc = await PDFDocument.load(await readFile((await scan('mix-src', ['Scanned page two'])).path));
    const [copied] = await doc.copyPages(scanDoc, [0]); doc.addPage(copied!);
    const path = join(root, 'mixed.pdf'); await writeFile(path, await doc.save());
    const r = await run([pdfIn(path, 'mixed.pdf')]);
    expect(r.stats).toMatchObject({ pagesRecognised: 1, pagesSkipped: 1 });
    expect(text(r.path, 1)).toBe('Born digital page');
    expect(text(r.path, 2)).toContain('Scanned page two');
    expect(r.warnings.join(' ')).toMatch(/already had text/);
  });

  it('can be told to recognise every page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([360, 144]).drawText('Born digital page', { x: 20, y: 70, size: 14, font });
    const path = join(root, 'digital.pdf'); await writeFile(path, await doc.save());
    expect((await run([pdfIn(path)], { skipTextPages: true })).stats).toMatchObject({ pagesRecognised: 0 });
    expect((await run([pdfIn(path)], { skipTextPages: false })).stats).toMatchObject({ pagesRecognised: 1 });
  });

  it('says so when there is nothing to do or nothing was found', async () => {
    const doc = await PDFDocument.create(); doc.addPage([300, 200]);
    const blank = join(root, 'blank.pdf'); await writeFile(blank, await doc.save());
    const r = await run([pdfIn(blank)]);
    expect(r.warnings.join(' ')).toMatch(/No text was recognised/);
    expect(r.stats).toMatchObject({ words: 0 });
  });

  it('rejects unavailable languages and bad option values', async () => {
    const f = await scan('s4', ['Hello']);
    await expect(run([f], { language: 'klingon' })).rejects.toMatchObject({ code: 'language_unavailable' });
    await expect(run([f], { language: 'eng; rm -rf /' })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run([f], { dpi: 20 })).rejects.toMatchObject({ code: 'invalid_options' });
  });

  it('OCR output works with find-and-redact: the recognised word is found and blacked out', async () => {
    const f = await scan('s5', ['Confidential Smith report']);
    const o = await run([f]);
    const red = await processTool('redact', { workDir: await (async () => { const d = join(root, `j${n++}`); await mkdir(d); return d; })(), inputs: [pdfIn(o.path)], options: { search: ['Smith'], dpi: 100 }, timeoutMs: 120_000, maxPages: 50 });
    expect(red.stats).toMatchObject({ textMatches: 1 });
    expect(text(red.path)).not.toContain('Smith');
  });
});

describe('TSV parsing', () => {
  const head = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  it('keeps recognised words with their boxes and drops structure rows, blanks and non-words', () => {
    const tsv = [head, '1\t1\t0\t0\t0\t0\t0\t0\t100\t50\t-1\t', '5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t96.5\tHello', '5\t1\t1\t1\t1\t2\t50\t20\t30\t12\t88\t  ', '5\t1\t1\t1\t1\t3\t90\t20\t0\t12\t90\tzero', '5\t1\t1\t1\t1\t4\t90\t20\t30\t12\t-1\tneg', ''].join('\n');
    expect(parseTsv(tsv)).toEqual([{ text: 'Hello', left: 10, top: 20, width: 30, height: 12, conf: 96.5 }]);
  });
});
