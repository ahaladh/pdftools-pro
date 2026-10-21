import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { processTool, type InputFile } from './index.js';

let root: string;
let n = 0;

async function makePdf(pages: number, name: string, text = (i: number) => `${name} page ${i + 1}`): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([400, 600]).drawText(text(i), { x: 50, y: 500, size: 20, font });
  const path = join(root, `${name}.pdf`);
  await writeFile(path, await doc.save());
  return { path, name: `${name}.pdf`, kind: 'pdf' };
}
async function run(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown = {}, timeoutMs = 60_000) {
  const workDir = join(root, `j${n++}`);
  await mkdir(workDir);
  return processTool(tool, { workDir, inputs, options, timeoutMs, maxPages: 100 });
}
const load = async (p: string, opts = {}) => PDFDocument.load(await readFile(p), opts);
const text = (p: string) => execFileSync('pdftotext', ['-layout', p, '-']).toString();

beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'core2-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('protect / unlock', () => {
  it('encrypts with AES-256, requires password, and unlocks with it', async () => {
    const src = await makePdf(2, 'sec');
    const p = await run('protect', [src], { password: 'p@ss "w" (x)' });
    const enc = await PDFDocument.load(await readFile(p.path), { ignoreEncryption: true });
    expect(enc.isEncrypted).toBe(true);
    // an unprotected load must refuse
    await expect(run('rotate', [{ path: p.path, name: 'e.pdf', kind: 'pdf' }], { angle: 90 })).rejects.toMatchObject({ code: 'encrypted_pdf' });
    const u = await run('unlock', [{ path: p.path, name: 'e.pdf', kind: 'pdf' }], { password: 'p@ss "w" (x)', confirmAuthorized: true });
    const dec = await load(u.path);
    expect(dec.getPageCount()).toBe(2);
    expect(text(u.path)).toContain('sec page 1');
  });
  it('rejects a wrong password and never produces output', async () => {
    const p = await run('protect', [await makePdf(1, 'sec2')], { password: 'right' });
    await expect(run('unlock', [{ path: p.path, name: 'e.pdf', kind: 'pdf' }], { password: 'wrong', confirmAuthorized: true })).rejects.toMatchObject({ code: 'wrong_password' });
  });
  it('requires the authorization confirmation and rejects unencrypted input', async () => {
    const f = await makePdf(1, 'plain');
    await expect(run('unlock', [f], { password: 'x' })).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('unlock', [f], { password: 'x', confirmAuthorized: true })).rejects.toMatchObject({ code: 'not_encrypted' });
  });
});

describe('poppler extraction', () => {
  it('extracts text and warns on empty (no text layer)', async () => {
    const r = await run('pdf-to-text', [await makePdf(2, 'tx')]);
    expect(await readFile(r.path, 'utf8')).toContain('tx page 2');
    const blank = await PDFDocument.create(); blank.addPage();
    const bp = join(root, 'blank.pdf'); await writeFile(bp, await blank.save());
    const r2 = await run('pdf-to-text', [{ path: bp, name: 'blank.pdf', kind: 'pdf' }]);
    expect(r2.warnings.join()).toMatch(/scanned/);
  });
  it('converts to HTML containing the text', async () => {
    const r = await run('pdf-to-html', [await makePdf(1, 'ht')]);
    const html = r.mime.startsWith('text/html') ? await readFile(r.path, 'utf8') : Buffer.from(unzipSync(new Uint8Array(await readFile(r.path)))['doc.html']!).toString();
    expect(html).toContain('ht page 1');
  });
  it('extracts embedded images and errors when there are none', async () => {
    await expect(run('extract-images', [await makePdf(1, 'noimg')])).rejects.toMatchObject({ code: 'no_images' });
    const png = await run('pdf-to-images', [await makePdf(1, 'src')], { format: 'png', dpi: 72 });
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(await readFile(png.path));
    doc.addPage([200, 200]).drawImage(img, { x: 0, y: 0, width: 100, height: 100 });
    const p = join(root, 'withimg.pdf'); await writeFile(p, await doc.save());
    const r = await run('extract-images', [{ path: p, name: 'withimg.pdf', kind: 'pdf' }]);
    expect(Object.keys(unzipSync(new Uint8Array(await readFile(r.path)))).length).toBe(1);
  });
});

describe('geometry', () => {
  it('crops by percentage and honours page rotation', async () => {
    const r = await run('crop', [await makePdf(1, 'cr')], { top: 10, bottom: 20, left: 0, right: 0 });
    const box = (await load(r.path)).getPage(0).getCropBox();
    expect(box.width).toBeCloseTo(400); expect(box.height).toBeCloseTo(420); expect(box.y).toBeCloseTo(120);
    // rotated 90: visual top maps to unrotated left edge
    const d = await PDFDocument.create(); d.addPage([400, 600]).setRotation({ type: 'degrees', angle: 90 } as never);
    const rp = join(root, 'rot.pdf'); await writeFile(rp, await d.save());
    const r2 = await run('crop', [{ path: rp, name: 'rot.pdf', kind: 'pdf' }], { top: 25 });
    const b2 = (await load(r2.path)).getPage(0).getCropBox();
    expect(b2.x).toBeCloseTo(100); expect(b2.width).toBeCloseTo(300); expect(b2.height).toBeCloseTo(600);
  });
  it('rejects empty/invalid crops', async () => {
    const f = await makePdf(1, 'cr2');
    await expect(run('crop', [f], {})).rejects.toMatchObject({ code: 'invalid_options' });
    await expect(run('crop', [f], { left: 60, right: 40 })).rejects.toMatchObject({ code: 'invalid_options' });
  });
  it('resizes to A4 keeping content and aspect ratio', async () => {
    const r = await run('resize', [await makePdf(2, 'rs')], { size: 'a4' });
    const d = await load(r.path);
    expect(d.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
    expect(text(r.path)).toContain('rs page 2');
  });
  it('adds blank pages at the chosen position', async () => {
    const r = await run('add-blank-pages', [await makePdf(2, 'bl')], { count: 2, after: 1 });
    const d = await load(r.path);
    expect(d.getPageCount()).toBe(4);
    const t = execFileSync('pdftotext', ['-f', '2', '-l', '2', r.path, '-']).toString().trim();
    expect(t).toBe('');
    expect(execFileSync('pdftotext', ['-f', '4', '-l', '4', r.path, '-']).toString()).toContain('bl page 2');
    const start = await run('add-blank-pages', [await makePdf(1, 'bl2')], { count: 1, after: 0 });
    expect(execFileSync('pdftotext', ['-f', '1', '-l', '1', start.path, '-']).toString().trim()).toBe('');
  });
});

describe('forms, compare, repair, office', () => {
  it('flattens form fields', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const tf = doc.getForm().createTextField('name');
    tf.setText('Alice'); tf.addToPage(page, { x: 20, y: 200, width: 150, height: 24 });
    const p = join(root, 'form.pdf'); await writeFile(p, await doc.save());
    const r = await run('flatten', [{ path: p, name: 'form.pdf', kind: 'pdf' }]);
    expect((await load(r.path)).getForm().getFields().length).toBe(0);
    expect(text(r.path)).toContain('Alice');
    await expect(run('flatten', [await makePdf(1, 'nof')])).rejects.toMatchObject({ code: 'no_form_fields' });
  });
  it('compares two PDFs by text', async () => {
    const a = await makePdf(1, 'ca', () => 'hello world'), b = await makePdf(1, 'cb', () => 'hello there');
    const r = await run('compare', [a, b]);
    expect(r.stats?.added).toBe(1); expect(r.stats?.removed).toBe(1);
    const html = await readFile(r.path, 'utf8');
    expect(html).toContain('hello world'); expect(html).toContain('hello there');
    await expect(run('compare', [a])).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('escapes document text in the HTML report (no script injection)', async () => {
    const a = await makePdf(1, 'xa', () => '<script>alert(1)</script>'), b = await makePdf(1, 'xb', () => 'safe');
    const html = await readFile((await run('compare', [a, b])).path, 'utf8');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
  it('repairs a PDF with a truncated tail', async () => {
    const src = await makePdf(3, 'dmg');
    const bytes = await readFile(src.path);
    const broken = join(root, 'broken.pdf'); await writeFile(broken, bytes.subarray(0, Math.floor(bytes.length * 0.8)));
    const r = await run('repair', [{ path: broken, name: 'broken.pdf', kind: 'pdf' }]);
    expect((await load(r.path)).getPageCount()).toBeGreaterThan(0);
  });
  it('reports unrecoverable files', async () => {
    const p = join(root, 'garbage.pdf'); await writeFile(p, '%PDF-1.4\nnot really');
    await expect(run('repair', [{ path: p, name: 'garbage.pdf', kind: 'pdf' }])).rejects.toMatchObject({ code: 'unrecoverable' });
  });
  it('converts a DOCX to PDF with LibreOffice', async () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office conversion works</w:t></w:r></w:p></w:body></w:document>'),
    });
    const p = join(root, 'memo.docx'); await writeFile(p, docx);
    const r = await run('office-to-pdf', [{ path: p, name: 'memo.docx', kind: 'office' }], {}, 120_000);
    expect(r.name).toBe('memo.pdf');
    expect(text(r.path)).toContain('Office conversion works');
  }, 150_000);
  it('fails cleanly on a corrupt Office file', async () => {
    const p = join(root, 'bad.docx'); await writeFile(p, 'PK\x03\x04 garbage');
    await expect(run('office-to-pdf', [{ path: p, name: 'bad.docx', kind: 'office' }], {}, 120_000)).rejects.toMatchObject({ code: 'engine_failed' });
  }, 150_000);
});

describe('fill-form', () => {
  async function formPdf(name: string, extra?: (form: ReturnType<PDFDocument['getForm']>, page: ReturnType<PDFDocument['addPage']>) => void) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    const form = doc.getForm();
    form.createTextField('person.name').addToPage(page, { x: 20, y: 440, width: 200, height: 24 });
    const cb = form.createCheckBox('agree'); cb.addToPage(page, { x: 20, y: 400, width: 18, height: 18 });
    const rg = form.createRadioGroup('size'); for (const [i, o] of ['small', 'large'].entries()) rg.addOptionToPage(o, page, { x: 20 + i * 60, y: 360, width: 16, height: 16 });
    const dd = form.createDropdown('country'); dd.addOptions(['India', 'Norway']); dd.addToPage(page, { x: 20, y: 310, width: 150, height: 24 });
    const ml = form.createTextField('note'); ml.enableMultiline(); ml.setMaxLength(12); ml.addToPage(page, { x: 20, y: 200, width: 200, height: 80 });
    const ro = form.createTextField('locked'); ro.setText('fixed'); ro.enableReadOnly(); ro.addToPage(page, { x: 20, y: 160, width: 100, height: 20 });
    extra?.(form, page);
    const path = join(root, `${name}.pdf`); await writeFile(path, await doc.save());
    return { path, name: `${name}.pdf`, kind: 'pdf' as const };
  }

  it('fills every field type and the values read back', async () => {
    const r = await run('fill-form', [await formPdf('ff1')], { values: { 'person.name': 'Åsa Lindqvist', agree: true, size: 'large', country: 'Norway', note: 'hello' } });
    const f = (await load(r.path)).getForm();
    expect(f.getTextField('person.name').getText()).toBe('Åsa Lindqvist');
    expect(f.getCheckBox('agree').isChecked()).toBe(true);
    expect(f.getRadioGroup('size').getSelected()).toBe('large');
    expect(f.getDropdown('country').getSelected()).toEqual(['Norway']);
    expect(r.stats).toMatchObject({ filled: 5, fields: 6 });
  });

  it('flatten makes the answers page content that an independent extractor sees, and removes the fields', async () => {
    const r = await run('fill-form', [await formPdf('ff2')], { values: { 'person.name': 'Alice Example', country: 'India', note: 'two\nlines' }, flatten: true });
    expect((await load(r.path)).getForm().getFields()).toHaveLength(0);
    const t = text(r.path);
    expect(t).toContain('Alice Example'); expect(t).toContain('India'); expect(t).toContain('two'); expect(t).toContain('lines');
  });

  it('without flatten, the filled values are drawn (appearance streams exist) and fields remain', async () => {
    const r = await run('fill-form', [await formPdf('ff3')], { values: { 'person.name': 'Visible Value' } });
    expect((await load(r.path)).getForm().getFields().length).toBe(6);
    // pdftotext renders widget appearances, so this proves an appearance was generated and not just /V set
    expect(text(r.path)).toContain('Visible Value');
  });

  it('refuses instead of guessing: unknown field, wrong type, bad option, read-only, too long, non-Latin text', async () => {
    const src = await formPdf('ff4');
    const bad = (values: Record<string, unknown>, re: RegExp) => expect(run('fill-form', [src], { values })).rejects.toMatchObject({ code: 'invalid_options', message: expect.stringMatching(re) });
    await bad({ nope: 'x' }, /no such field/);
    await bad({ agree: 'yes' }, /checked or unchecked/);
    await bad({ size: 'medium' }, /not one of: small, large/);
    await bad({ country: 'Atlantis' }, /not one of: India, Norway/);
    await bad({ locked: 'changed' }, /read-only/);
    await bad({ note: 'this is far too long' }, /longer than the field allows/);
    await bad({ 'person.name': 'Привет' }, /Latin/);
  });

  it('errors clearly for a PDF without fields and for an empty request', async () => {
    await expect(run('fill-form', [await makePdf(1, 'nofields')], { values: { a: 'b' } })).rejects.toMatchObject({ code: 'no_form_fields' });
    await expect(run('fill-form', [await formPdf('ff5')], {})).rejects.toMatchObject({ code: 'invalid_options' });
  });

  it('clears a field when given an empty value, and leaves untouched fields alone', async () => {
    const first = await run('fill-form', [await formPdf('ff6')], { values: { 'person.name': 'Temp', note: 'keep' } });
    const second = await run('fill-form', [{ path: first.path, name: 'x.pdf', kind: 'pdf' }], { values: { 'person.name': '' } });
    const f = (await load(second.path)).getForm();
    expect(f.getTextField('person.name').getText()).toBeUndefined();
    expect(f.getTextField('note').getText()).toBe('keep');
  });

  it('rejects XFA forms rather than producing a half-filled file', async () => {
    const src = await formPdf('ff7');
    const doc = await load(src.path, { preserveXFA: true });
    doc.getForm().acroForm.dict.set(PDFName.of('XFA'), doc.context.obj([]));
    const p = join(root, 'xfa.pdf'); await writeFile(p, await doc.save());
    await expect(run('fill-form', [{ path: p, name: 'xfa.pdf', kind: 'pdf' }], { values: { note: 'x' } })).rejects.toMatchObject({ code: 'unsupported_form' });
  });
});
