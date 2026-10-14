import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { processTool, type InputFile } from './index.js';
import { findHits, parseBBox, type PageWords } from './search.js';

let root: string;
let n = 0;
const DPI = 100;

type Spec = { text: string; x: number; y: number }[];
async function pdfOf(name: string, specs: Spec[], rotation = 0): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of specs) {
    const p = doc.addPage([400, 200]);
    for (const t of spec) p.drawText(t.text, { x: t.x, y: t.y, size: 18, font });
    p.setRotation(degrees(rotation));
  }
  const path = join(root, `${name}.pdf`);
  await writeFile(path, await doc.save());
  return { path, name: `${name}.pdf`, kind: 'pdf' };
}
async function run(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool(tool, { workDir, inputs, options, timeoutMs: 120_000, maxPages: 50 });
}
/** Render a page to 8-bit grey and return pixels (0 = black). */
function gray(pdf: string, page = 1) {
  const stem = join(root, `g${n++}`);
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', String(page), '-l', String(page), '-png', '-singlefile', pdf, stem]);
  const dims = execFileSync('identify', ['-format', '%w %h', `${stem}.png`]).toString().split(' ').map(Number) as [number, number];
  const data = execFileSync('convert', [`${stem}.png`, '-colorspace', 'Gray', '-depth', '8', 'gray:-'], { maxBuffer: 1 << 26 });
  return { w: dims[0], h: dims[1], data };
}
const darkAt = (g: ReturnType<typeof gray>) => { const s: number[] = []; for (let i = 0; i < g.data.length; i++) if (g.data[i]! < 128) s.push(i); return s; };

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'search-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('matching (pure)', () => {
  const page: PageWords = {
    width: 400, height: 200,
    words: [
      { text: 'Call', x0: 10, y0: 10, x1: 40, y1: 24 }, { text: 'John', x0: 45, y0: 10, x1: 80, y1: 24 },
      { text: 'Smith', x0: 85, y0: 10, x1: 125, y1: 24 }, { text: 'Hannah', x0: 10, y0: 40, x1: 70, y1: 54 },
    ],
  };
  it('merges the words of a phrase into one box on the same line', () => {
    const { hits, perTerm } = findHits([page], ['john smith'], false);
    expect(perTerm.get('john smith')).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.x).toBeCloseTo(44 / 400, 3);
    expect(hits[0]!.x + hits[0]!.w).toBeCloseTo(126 / 400, 3);
  });
  it('is case-insensitive unless asked, and covers the whole word for a partial match', () => {
    expect(findHits([page], ['JOHN'], true).hits).toHaveLength(0);
    expect(findHits([page], ['JOHN'], false).hits).toHaveLength(1);
    const h = findHits([page], ['ann'], false).hits[0]!;
    expect(h.x).toBeCloseTo(9 / 400, 3); expect(h.x + h.w).toBeCloseTo(71 / 400, 3);
  });
  it('splits a phrase that wraps onto the next line into one box per line', () => {
    const { hits } = findHits([page], ['smith hannah'], false);
    expect(hits).toHaveLength(2);
  });
  it('parses pdftotext -bbox output including entities', () => {
    const xml = '<doc><page width="100.0" height="50.0"><word xMin="1.5" yMin="2" xMax="10" yMax="9">A&amp;B &#65;</word></page></doc>';
    expect(parseBBox(xml)).toEqual([{ width: 100, height: 50, words: [{ text: 'A&B A', x0: 1.5, y0: 2, x1: 10, y1: 9 }] }]);
  });
});

describe('redact by search', () => {
  for (const rot of [0, 90, 270]) {
    it(`blacks out the matched word, leaves the rest, and removes the text (page /Rotate ${rot})`, async () => {
      const both = await pdfOf(`both${rot}`, [[{ text: 'SECRET', x: 20, y: 150 }, { text: 'public', x: 200, y: 60 }]], rot);
      const secretOnly = await pdfOf(`s${rot}`, [[{ text: 'SECRET', x: 20, y: 150 }]], rot);
      const publicOnly = await pdfOf(`p${rot}`, [[{ text: 'public', x: 200, y: 60 }]], rot);
      const r = await run('redact', [both], { search: ['secret'], dpi: DPI });
      expect(r.stats).toMatchObject({ textMatches: 1, pagesRedacted: 1 });
      const out = gray(r.path), s = gray(secretOnly.path), p = gray(publicOnly.path);
      expect(out.w).toBe(s.w); expect(out.h).toBe(s.h);
      // every glyph pixel of SECRET is now solid black
      const sDark = darkAt(s);
      expect(sDark.length).toBeGreaterThan(50);
      expect(sDark.every((i) => out.data[i]! < 40)).toBe(true);
      // "public" is still visible (its glyph pixels are still dark, mostly)
      const pDark = darkAt(p);
      expect(pDark.filter((i) => out.data[i]! < 200).length / pDark.length).toBeGreaterThan(0.9);
      // the matched text is not recoverable from the file
      expect(execFileSync('pdftotext', [r.path, '-']).toString()).not.toMatch(/SECRET|public/i);
    });
  }

  it('only rasterizes pages with matches; other pages keep their text layer', async () => {
    const f = await pdfOf('multi', [[{ text: 'nothing here', x: 20, y: 100 }], [{ text: 'the SECRET page', x: 20, y: 100 }]]);
    const r = await run('redact', [f], { search: ['SECRET'], dpi: DPI });
    expect(r.stats).toMatchObject({ pagesRedacted: 1 });
    expect(execFileSync('pdftotext', ['-f', '1', '-l', '1', r.path, '-']).toString()).toContain('nothing here');
    expect(execFileSync('pdftotext', ['-f', '2', '-l', '2', r.path, '-']).toString().trim()).toBe('');
  });

  it('combines search with drawn areas', async () => {
    const f = await pdfOf('combo', [[{ text: 'SECRET', x: 20, y: 150 }]]);
    const r = await run('redact', [f], { search: ['SECRET'], redactions: [{ page: 0, x: 0.8, y: 0.8, w: 0.1, h: 0.1 }], dpi: DPI });
    expect(r.stats).toMatchObject({ areas: 2 });
  });

  it('fails loudly instead of returning an unredacted copy when nothing matches', async () => {
    const f = await pdfOf('none', [[{ text: 'hello', x: 20, y: 100 }]]);
    await expect(run('redact', [f], { search: ['absent'], dpi: DPI })).rejects.toMatchObject({ code: 'no_matches' });
  });

  it('warns about terms that matched nothing when others did', async () => {
    const f = await pdfOf('some', [[{ text: 'SECRET', x: 20, y: 100 }]]);
    const r = await run('redact', [f], { search: ['SECRET', 'absent'], dpi: DPI });
    expect(r.warnings.join(' ')).toContain('"absent"');
  });

  it('is plain-text matching: regex characters are literal', async () => {
    const f = await pdfOf('lit', [[{ text: 'abc a.c', x: 20, y: 100 }]]);
    const r = await run('redact', [f], { search: ['a.c'], dpi: DPI });
    expect(r.stats).toMatchObject({ textMatches: 1 });
  });

  it('needs something to redact', async () => {
    const f = await pdfOf('empty', [[{ text: 'x', x: 20, y: 100 }]]);
    await expect(run('redact', [f], {})).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('redact', [f], { search: [' '] })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});
