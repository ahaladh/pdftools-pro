import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { processTool, type InputFile } from './index.js';
import { analyzePage } from './content-edit.js';
import { parseBBox } from './search.js';

let root: string;
let n = 0;
const pdfIn = (path: string, name = 'in.pdf'): InputFile => ({ path, name, kind: 'pdf' });
async function run(inputs: InputFile[], options: unknown) {
  const workDir = join(root, `j${n++}`); await mkdir(workDir);
  return processTool('edit-content', { workDir, inputs, options, timeoutMs: 120_000, maxPages: 50 });
}
const words = (pdf: string, page = 1) => parseBBox(execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdf, '-']).toString())[0]!;
const text = (pdf: string, page = 1) => execFileSync('pdftotext', ['-f', String(page), '-l', String(page), pdf, '-']).toString();
/** Display-fraction box (top-left origin) around a word found by an independent tool (pdftotext). */
function boxOf(pdf: string, word: string, page = 1, swap = false) {
  const pg = words(pdf, page);
  if (swap) [pg.width, pg.height] = [pg.height, pg.width]; // pdftotext reports word boxes rotated but page size unrotated
  const w = pg.words.find((x) => x.text === word);
  if (!w) throw new Error(`word ${word} not found: ${pg.words.map((x) => x.text).join(' ')}`);
  return { page: page - 1, x: (w.x0 - 1) / pg.width, y: (w.y0 - 1) / pg.height, w: (w.x1 - w.x0 + 2) / pg.width, h: (w.y1 - w.y0 + 2) / pg.height };
}

async function pdfLibDoc(name: string, rotation = 0): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 200]);
  p.drawText('Invoice for Alice Smith', { x: 30, y: 150, size: 18, font });
  p.drawText('Total due 1250 dollars', { x: 30, y: 110, size: 14, font });
  p.setRotation(degrees(rotation));
  const path = join(root, `${name}.pdf`); await writeFile(path, await doc.save());
  return pdfIn(path, `${name}.pdf`);
}
/** A PDF produced by LibreOffice: subsetted TrueType, Identity-H, ToUnicode: how most real documents look. */
async function loDoc(name: string, body: string): Promise<InputFile> {
  const dir = join(root, `lo-${name}`); await mkdir(dir);
  await writeFile(join(dir, `${name}.txt`), body);
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'pdf', '--outdir', dir, join(dir, `${name}.txt`)], { stdio: 'ignore', timeout: 120_000 });
  return pdfIn(join(dir, `${name}.pdf`), `${name}.pdf`);
}

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'cedit-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('glyph geometry agrees with an independent tool', () => {
  for (const [label, make] of [['pdf-lib standard font', () => pdfLibDoc('geo-std')], ['LibreOffice subset font', () => loDoc('geo-lo', 'Hello brave new world\nSecond line of text\n')]] as const) {
    it(`${label}: every word's extent matches pdftotext's boxes`, async () => {
      const f = await make();
      const doc = await PDFDocument.load(await readFile(f.path));
      const a = await analyzePage(doc, doc.getPage(0));
      const mine = a.shows.flatMap((s) => s.items).flatMap((i) => ('g' in i ? [i.g] : []));
      expect(mine.length).toBeGreaterThan(10);
      const pg = words(f.path);
      const H = doc.getPage(0).getHeight();
      let checked = 0;
      for (const w of pg.words) {
        // glyphs whose centre falls in the oracle's word box, converted to user space (y flips)
        const inW = mine.filter((g) => { const cx = (g.box[0] + g.box[2]) / 2, cy = H - (g.box[1] + g.box[3]) / 2; return cx >= w.x0 - 0.5 && cx <= w.x1 + 0.5 && cy >= w.y0 - 1 && cy <= w.y1 + 1; });
        expect(inW.map((g) => g.text).join(''), `word "${w.text}"`).toBe(w.text);
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
    });
  }
});

describe('text editing', () => {
  it('standard font: removes the old word from the content, writes the new one, leaves neighbours where they were', async () => {
    const f = await pdfLibDoc('t1');
    const before = words(f.path);
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), original: 'Alice', replacement: 'Robert' }] });
    expect(r.stats).toMatchObject({ textEdits: 1, glyphsRemoved: 5 });
    const t = text(r.path);
    expect(t).toContain('Robert'); expect(t).not.toContain('Alice');
    // not a cover-up: the old letters are not in any content stream either (literal or hex form)
    const out = await PDFDocument.load(await readFile(r.path));
    const content = (await analyzePage(out, out.getPage(0))).src;
    expect(content).not.toContain('Alice'); expect(content.toLowerCase()).not.toContain('416c696365');
    const after = words(r.path);
    for (const w of ['Invoice', 'for', 'Smith', 'Total', 'due', '1250', 'dollars']) {
      const a = before.words.find((x) => x.text === w)!, b = after.words.find((x) => x.text === w)!;
      expect(Math.abs(a.x0 - b.x0), `${w} x`).toBeLessThan(0.6);
      expect(Math.abs(a.y0 - b.y0), `${w} y`).toBeLessThan(0.6);
    }
    const robert = after.words.find((x) => x.text === 'Robert')!, alice = before.words.find((x) => x.text === 'Alice')!;
    expect(Math.abs(robert.x0 - alice.x0)).toBeLessThan(1);
    expect(Math.abs(robert.y1 - alice.y1)).toBeLessThan(2);
  });

  it('LibreOffice subset font (Identity-H + ToUnicode): the same guarantees hold', async () => {
    const f = await loDoc('t2', 'Dear customer Alice\nYour order ships tomorrow\n');
    const before = words(f.path);
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), original: 'Alice', replacement: 'Bob' }] });
    const t = text(r.path);
    expect(t).toContain('Dear customer Bob'); expect(t).not.toContain('Alice');
    const after = words(r.path);
    for (const w of ['Dear', 'customer', 'Your', 'order', 'ships', 'tomorrow']) {
      const a = before.words.find((x) => x.text === w)!, b = after.words.find((x) => x.text === w)!;
      expect(Math.abs(a.x0 - b.x0), `${w} x`).toBeLessThan(0.6);
      expect(Math.abs(a.y0 - b.y0), `${w} y`).toBeLessThan(0.6);
    }
  });

  it('a word in the middle of a line leaves the words after it exactly in place', async () => {
    const f = await loDoc('t3', 'one two three four five six\n');
    const before = words(f.path);
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'three'), replacement: 'X' }] });
    const after = words(r.path);
    for (const w of ['one', 'two', 'four', 'five', 'six']) expect(Math.abs(before.words.find((x) => x.text === w)!.x0 - after.words.find((x) => x.text === w)!.x0), w).toBeLessThan(0.6);
    expect(text(r.path)).not.toContain('three');
  });

  it('empty replacement deletes the text', async () => {
    const f = await pdfLibDoc('t4');
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Smith'), replacement: '' }] });
    expect(text(r.path)).not.toContain('Smith');
    expect(text(r.path)).toContain('Alice');
  });

  for (const rot of [90, 180, 270]) {
    it(`rotated page (/Rotate ${rot}) edits the right word and the new text reads in the same direction`, async () => {
      const f = await pdfLibDoc(`rot${rot}`, rot);
      const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice', 1, rot % 180 === 90), replacement: 'Robert' }] });
      const t = text(r.path);
      expect(t).toContain('Robert'); expect(t).not.toContain('Alice'); expect(t).toContain('Smith');
    });
  }

  it('reports instead of guessing when nothing editable is under the box', async () => {
    const f = await pdfLibDoc('t5');
    await expect(run([f], { textEdits: [{ page: 0, x: 0.8, y: 0.8, w: 0.1, h: 0.1, replacement: 'x' }] })).rejects.toMatchObject({ code: 'text_not_found' });
  });
  it('warns when the file disagrees with what the client thought it was editing', async () => {
    const f = await pdfLibDoc('t6');
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), original: 'Zed', replacement: 'Bob' }] });
    expect(r.warnings.join(' ')).toMatch(/reads "Alice", not "Zed"/);
  });
  it('rejects replacement characters the standard fonts cannot draw', async () => {
    const f = await pdfLibDoc('t7');
    await expect(run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), replacement: '日本語' }] })).rejects.toMatchObject({ code: 'unsupported_text' });
  });
  it('validates options', async () => {
    const f = await pdfLibDoc('t8');
    await expect(run([f], {})).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run([f], { textEdits: [{ page: 5, x: 0, y: 0, w: 0.1, h: 0.1, replacement: 'x' }] })).rejects.toMatchObject({ code: 'invalid_options' });
  });
});

describe('other producers and kerned text', () => {
  it('Ghostscript-rewritten PDF (different font embedding and operators) edits correctly', async () => {
    const src = await loDoc('gs-src', 'Quarterly report for Acme Corporation\nPrepared by Finance\n');
    const out = join(root, 'gs-out.pdf');
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-sOutputFile=${out}`, src.path]);
    const f = pdfIn(out, 'gs-out.pdf');
    const before = words(out);
    const r = await run([f], { textEdits: [{ ...boxOf(out, 'Acme'), replacement: 'Zeta' }] });
    const t = text(r.path);
    expect(t).toContain('Zeta Corporation'); expect(t).not.toContain('Acme');
    for (const w of ['Quarterly', 'report', 'for', 'Corporation', 'Prepared', 'Finance']) {
      expect(Math.abs(before.words.find((x) => x.text === w)!.x0 - words(r.path).words.find((x) => x.text === w)!.x0), w).toBeLessThan(0.6);
    }
  });

  it('a TJ array with kerning: only the selected characters go, the rest keep their positions', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([400, 100]);
    p.drawText('x', { x: 0, y: 0, size: 1, font }); // makes pdf-lib register the font on the page
    const key = (p.node.Resources()!.lookup(PDFName.of('Font'), PDFDict) as PDFDict).keys()[0]!.decodeText();
    // hand-written content with explicit kerning
    p.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`BT /${key} 20 Tf 20 50 Td [(AV) -80 (ATAR) 120 ( sale)] TJ ET`)));
    const path = join(root, 'kern.pdf'); await writeFile(path, await doc.save());
    const before = words(path);
    expect(before.words.map((w) => w.text)).toEqual(['AVATAR', 'sale']);
    const r = await run([pdfIn(path, 'kern.pdf')], { textEdits: [{ ...boxOf(path, 'sale'), replacement: 'SALE' }] });
    const after = words(r.path);
    const a = before.words.find((w) => w.text === 'AVATAR')!, b = after.words.find((w) => w.text === 'AVATAR')!;
    expect(Math.abs(a.x1 - b.x1)).toBeLessThan(0.5); // the kerned word is untouched
    expect(text(r.path)).toContain('SALE'); expect(text(r.path)).not.toContain('sale');
  });

  it('warns when the replacement is wider than the gap and would overlap the next word', async () => {
    const f = await pdfLibDoc('wide');
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), replacement: 'Alexandrina-Marguerite' }] });
    expect(r.warnings.join(' ')).toMatch(/overlaps the text after it/);
    const ok = await run([f], { textEdits: [{ ...boxOf(f.path, 'Alice'), replacement: 'Bo' }] });
    expect(ok.warnings.join(' ')).not.toMatch(/overlaps/);
  });
});

describe('image editing', () => {
  const png = (name: string, size: string, spec: string) => { const p = join(root, `${name}.png`); execFileSync('convert', ['-size', size, spec, `png:${p}`]); return p; };
  const imgList = (pdf: string, page?: number) => execFileSync('pdfimages', ['-list', ...(page ? ['-f', String(page), '-l', String(page)] : []), pdf]).toString().trim().split('\n').slice(2).filter(Boolean);
  const pixel = (pdf: string, x: number, y: number) => {
    const stem = join(root, `px${n++}`);
    execFileSync('pdftoppm', ['-r', '72', '-png', '-singlefile', pdf, stem]);
    return execFileSync('convert', [`${stem}.png`, '-format', `%[pixel:p{${x},${y}}]`, 'info:']).toString().replace(/\s/g, '');
  };
  const isBlue = (c: string) => /^(blue|srgb\(\d{1,2},\d{1,2},2[3-5]\d\))/.test(c);
  const isWhite = (c: string) => /^(white|srgb\(25[0-5],25[0-5],25[0-5]\))/.test(c);

  /** One page, a noisy photo-like PNG at (50,50) 200x100 pt and a caption. */
  async function withImage(name: string, pages = 1, shareResources = false): Promise<{ f: InputFile; box: { x: number; y: number; w: number; h: number } }> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const img = await doc.embedPng(await readFile(png(`${name}-src`, '240x120', 'plasma:red-yellow')));
    for (let i = 0; i < pages; i++) {
      const p = doc.addPage([400, 300]);
      p.drawImage(img, { x: 50, y: 150, width: 200, height: 100 }); // top edge at y=250 -> 50 from the top
      p.drawText('caption stays', { x: 50, y: 120, size: 14, font });
    }
    if (shareResources && pages > 1) {
      // Pages 1 and 2 share ONE resource dictionary and ONE content stream (as some producers do).
      const first = doc.getPage(0).node;
      const resRef = doc.context.register(first.Resources()!);
      const contents = first.get(PDFName.of('Contents'));
      for (let i = 0; i < pages; i++) { const nd = doc.getPage(i).node; nd.set(PDFName.of('Resources'), resRef); nd.set(PDFName.of('Contents'), contents!); }
    }
    const path = join(root, `${name}.pdf`); await writeFile(path, await doc.save());
    return { f: pdfIn(path, `${name}.pdf`), box: { x: 50 / 400, y: 50 / 300, w: 200 / 400, h: 100 / 300 } };
  }

  it('delete: the image is gone from the page AND from the file', async () => {
    const { f, box } = await withImage('imgdel');
    expect(imgList(f.path)).toHaveLength(1);
    const r = await run([f], { imageEdits: [{ page: 0, ...box, action: 'delete' }] });
    expect(r.stats).toMatchObject({ imagesDeleted: 1, imageObjectsRemoved: 1 });
    expect(imgList(r.path)).toHaveLength(0);
    expect((await readFile(r.path)).length).toBeLessThan((await readFile(f.path)).length / 2); // the pixel data is not still sitting in the file
    const out = await PDFDocument.load(await readFile(r.path));
    const hasImageObject = [...out.context.enumerateIndirectObjects()].some(([, o]) => /\/Subtype\s*\/Image|Subtype.*Image/.test(String((o as { dict?: unknown }).dict ?? '')) && (o as { dict?: { get(k: unknown): unknown } }).dict?.get(PDFName.of('Subtype'))?.toString() === '/Image');
    expect(hasImageObject).toBe(false);
    expect(text(r.path)).toContain('caption stays');
    expect(isWhite(pixel(r.path, 150, 100))).toBe(true); // where the picture was
  });

  it('replace: the new picture fills the same frame (contain keeps its proportions)', async () => {
    const { f, box } = await withImage('imgrep');
    const flat = png('blue', '300x60', 'xc:blue'); // much wider than the 2:1 frame
    const r = await run([f, { path: flat, name: 'blue.png', kind: 'png' }], { imageEdits: [{ page: 0, ...box, action: 'replace', imageIndex: 0, fit: 'contain' }] });
    expect(r.stats).toMatchObject({ imagesReplaced: 1 });
    const list = imgList(r.path);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(/\b300\s+60\b/); // the NEW image, not the old 240x120 one
    expect(isBlue(pixel(r.path, 150, 100))).toBe(true);        // centre of the frame
    expect(isWhite(pixel(r.path, 150, 57))).toBe(true);        // frame top edge: letterbox, not stretched
    expect(text(r.path)).toContain('caption stays');
  });

  it('replace with stretch fills the whole frame', async () => {
    const { f, box } = await withImage('imgstretch');
    const flat = png('blue2', '300x60', 'xc:blue');
    const r = await run([f, { path: flat, name: 'b.png', kind: 'png' }], { imageEdits: [{ page: 0, ...box, action: 'replace', imageIndex: 0, fit: 'stretch' }] });
    expect(isBlue(pixel(r.path, 150, 57))).toBe(true);
  });

  it('an image shared by two pages (and one shared resource dictionary): editing page 1 leaves page 2 intact', async () => {
    const { f, box } = await withImage('imgshared', 2, true);
    expect(imgList(f.path, 1)).toHaveLength(1); expect(imgList(f.path, 2)).toHaveLength(1);
    const r = await run([f], { imageEdits: [{ page: 0, ...box, action: 'delete' }] });
    expect(imgList(r.path, 1)).toHaveLength(0);
    expect(imgList(r.path, 2)).toHaveLength(1); // still there
    expect(text(r.path, 2)).toContain('caption stays');
    const both = await run([f], { imageEdits: [{ page: 0, ...box, action: 'delete' }, { page: 1, ...box, action: 'delete' }] });
    expect(imgList(both.path)).toHaveLength(0);
    expect((await readFile(both.path)).length).toBeLessThan((await readFile(f.path)).length / 2); // now nothing references it, so it is deleted
  });

  it('picks the image under the box when there are several', async () => {
    const doc = await PDFDocument.create();
    const a = await doc.embedPng(await readFile(png('ia', '60x60', 'xc:red'))), b = await doc.embedPng(await readFile(png('ib', '60x60', 'xc:lime')));
    const p = doc.addPage([400, 200]);
    p.drawImage(a, { x: 20, y: 100, width: 80, height: 80 }); p.drawImage(b, { x: 200, y: 100, width: 80, height: 80 });
    const path = join(root, 'two.pdf'); await writeFile(path, await doc.save());
    const r = await run([pdfIn(path)], { imageEdits: [{ page: 0, x: 200 / 400, y: 20 / 200, w: 80 / 400, h: 80 / 200, action: 'delete' }] });
    expect(imgList(r.path)).toHaveLength(1);
    expect(isWhite(pixel(r.path, 240, 60))).toBe(true);
    expect(isWhite(pixel(r.path, 60, 60))).toBe(false); // the other one survived
  });

  it('reports instead of guessing when no image is under the box, or the replacement is missing', async () => {
    const { f } = await withImage('imgmiss');
    await expect(run([f], { imageEdits: [{ page: 0, x: 0.7, y: 0.7, w: 0.2, h: 0.2, action: 'delete' }] })).rejects.toMatchObject({ code: 'image_not_found' });
    await expect(run([f], { imageEdits: [{ page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.3, action: 'replace' }] })).rejects.toMatchObject({ code: 'invalid_options' });
  });

  it('text and image edits can be combined in one pass', async () => {
    const { f, box } = await withImage('combo');
    const r = await run([f], { textEdits: [{ ...boxOf(f.path, 'stays'), replacement: 'moved' }], imageEdits: [{ page: 0, ...box, action: 'delete' }] });
    expect(imgList(r.path)).toHaveLength(0);
    expect(text(r.path)).toContain('caption moved'); expect(text(r.path)).not.toContain('stays');
  });
});
