import { readFile, writeFile, readdir, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import { diffLines } from 'diff';
import type { ToolId } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { loadPdf, loadPdfFile } from './pdf.js';
import { runEngine, PDF_MIME, baseName, one, pages, parseOptions, savePdf, zipResult, type Processor } from './helpers.js';

// ------------------------------------------------------------ office -> pdf
const OFFICE_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);

const officeToPdf: Processor = async (ctx) => {
  parseOptions('office-to-pdf', ctx.options);
  const f = one(ctx);
  const ext = extname(f.name).toLowerCase();
  if (!OFFICE_EXT.has(ext)) throw new ToolError('invalid_input', 'Unsupported Office file type.');
  const src = join(ctx.workDir, `input${ext}`);
  await copyFile(f.path, src);
  const outDir = join(ctx.workDir, 'lo-out');
  await mkdir(outDir);
  // Per-job profile dir: no shared state between jobs, nothing persists after cleanup.
  await runEngine(ctx, 'soffice', [
    `-env:UserInstallation=file://${join(ctx.workDir, 'lo-profile')}`,
    '--headless', '--norestore', '--nologo', '--nofirststartwizard',
    '--convert-to', 'pdf', '--outdir', outDir, src,
  ], { office: true });
  const out = join(outDir, 'input.pdf');
  try { await stat(out); } catch { throw new ToolError('engine_failed', 'The document could not be converted. It may be corrupt, password-protected or unsupported.'); }
  await loadPdfFile(out, Number.MAX_SAFE_INTEGER); // result sanity check
  return {
    path: out, name: `${baseName(f.name)}.pdf`, mime: PDF_MIME,
    warnings: ['Converted with LibreOffice. Fonts, SmartArt, macros and advanced layout may differ from Microsoft Office.'],
  };
};

// ------------------------------------------------------------ protect / unlock
const protect: Processor = async (ctx) => {
  const o = parseOptions('protect', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  doc.encrypt({
    userPassword: o.password,
    ownerPassword: o.ownerPassword || o.password,
    permissions: { printing: 'highResolution', copying: true, annotating: true, fillingForms: true, modifying: true, contentAccessibility: true, documentAssembly: true },
    algorithm: 'AES-256',
  });
  return savePdf(ctx, doc, `${baseName(f.name)}-protected.pdf`, ['Encrypted with AES-256. If you lose the password the file cannot be recovered.']);
};

const unlock: Processor = async (ctx) => {
  const o = parseOptions('unlock', ctx.options);
  const f = one(ctx);
  const bytes = await readFile(f.path);
  // Detect encryption without decrypting.
  let encrypted = false;
  try { encrypted = (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted; } catch {
    throw new ToolError('invalid_pdf', 'This file is not a valid or readable PDF.');
  }
  if (!encrypted) throw new ToolError('not_encrypted', 'This PDF is not password-protected.');
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { password: o.password, updateMetadata: false }); } catch {
    // Never reveal anything beyond "wrong"; no hints, no bypass.
    throw new ToolError('wrong_password', 'The password is incorrect.');
  }
  if (doc.getPageCount() > ctx.maxPages) throw new ToolError('too_many_pages', `PDF has more than ${ctx.maxPages} pages.`);
  // Saving the decrypted document in place keeps an /Encrypt entry in this library, so copy the
  // pages into a fresh, never-encrypted document instead.
  const clean = await PDFDocument.create();
  for (const p of await clean.copyPages(doc, doc.getPageIndices())) clean.addPage(p);
  const out = await savePdf(ctx, clean, `${baseName(f.name)}-unlocked.pdf`, ['Pages were copied into a new unprotected file; bookmarks, form data and document metadata may not be preserved.']);
  const check = await PDFDocument.load(await readFile(out.path), { ignoreEncryption: true, updateMetadata: false });
  if (check.isEncrypted) throw new ToolError('engine_failed', 'Could not remove protection from this file.');
  return out;
};

// ------------------------------------------------------------ poppler extraction
const pdfToText: Processor = async (ctx) => {
  parseOptions('pdf-to-text', ctx.options);
  const f = one(ctx);
  await loadPdfFile(f.path, ctx.maxPages);
  const out = join(ctx.workDir, 'result.txt');
  await runEngine(ctx, 'pdftotext', ['-layout', '-enc', 'UTF-8', f.path, out]);
  const text = await readFile(out, 'utf8');
  const warnings = text.replace(/[\s\f]/g, '') === '' ? ['No text layer was found. This looks like a scanned PDF: run it through the OCR PDF tool first.'] : [];
  return { path: out, name: `${baseName(f.name)}.txt`, mime: 'text/plain; charset=utf-8', warnings, stats: { characters: text.length } };
};

const pdfToHtml: Processor = async (ctx) => {
  parseOptions('pdf-to-html', ctx.options);
  const f = one(ctx);
  await loadPdfFile(f.path, ctx.maxPages);
  const dir = join(ctx.workDir, 'html');
  await mkdir(dir);
  await runEngine(ctx, 'pdftohtml', ['-noframes', '-enc', 'UTF-8', '-nodrm', f.path, join(dir, 'doc')]);
  const names = (await readdir(dir)).sort();
  if (!names.includes('doc.html')) throw new ToolError('engine_failed', 'No HTML was produced.');
  const warnings = ['Output is positioned text per page, not reflowable HTML. Complex layouts are approximated.'];
  if (names.length === 1) return { path: join(dir, 'doc.html'), name: `${baseName(f.name)}.html`, mime: 'text/html; charset=utf-8', warnings };
  const entries = await Promise.all(names.map(async (n) => ({ name: n, data: new Uint8Array(await readFile(join(dir, n))) })));
  const r = await zipResult(ctx, entries, `${baseName(f.name)}-html.zip`, 6);
  r.warnings = warnings;
  return r;
};

const extractImages: Processor = async (ctx) => {
  parseOptions('extract-images', ctx.options);
  const f = one(ctx);
  await loadPdfFile(f.path, ctx.maxPages);
  const dir = join(ctx.workDir, 'imgs');
  await mkdir(dir);
  await runEngine(ctx, 'pdfimages', ['-all', f.path, join(dir, 'img')]);
  const names = (await readdir(dir)).sort();
  if (names.length === 0) throw new ToolError('no_images', 'No embedded images were found in this PDF.');
  const entries = await Promise.all(names.map(async (n) => ({ name: n, data: new Uint8Array(await readFile(join(dir, n))) })));
  const r = await zipResult(ctx, entries, `${baseName(f.name)}-images.zip`, 0);
  r.stats = { images: names.length };
  return r;
};

// ------------------------------------------------------------ page geometry
type Box = { l: number; b: number; r: number; t: number };

/** Map visual (as displayed) edge insets to unrotated page-space insets for a given /Rotate. */
function insetsForRotation(rot: number, v: { top: number; right: number; bottom: number; left: number }): Box {
  switch (((rot % 360) + 360) % 360) {
    case 90: return { l: v.top, b: v.left, r: v.bottom, t: v.right };
    case 180: return { l: v.right, b: v.top, r: v.left, t: v.bottom };
    case 270: return { l: v.bottom, b: v.right, r: v.top, t: v.left };
    default: return { l: v.left, b: v.bottom, r: v.right, t: v.top };
  }
}

const crop: Processor = async (ctx) => {
  const o = parseOptions('crop', ctx.options);
  const f = one(ctx);
  if (o.left + o.right >= 100 || o.top + o.bottom >= 100) throw new ToolError('invalid_options', 'Crop margins must leave some page visible.');
  if (!o.left && !o.right && !o.top && !o.bottom) throw new ToolError('invalid_options', 'Enter at least one margin to crop.');
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const vis = { top: o.top, right: o.right, bottom: o.bottom, left: o.left };
  for (const i of pages(o.pages, doc.getPageCount())) {
    const page = doc.getPage(i);
    const base = page.getCropBox();
    const ins = insetsForRotation(page.getRotation().angle, vis);
    // Percent of the dimension that edge runs along, measured on the unrotated box.
    const x = base.x + (ins.l / 100) * base.width;
    const y = base.y + (ins.b / 100) * base.height;
    const w = base.width * (1 - (ins.l + ins.r) / 100);
    const h = base.height * (1 - (ins.t + ins.b) / 100);
    page.setCropBox(x, y, w, h);
  }
  return savePdf(ctx, doc, `${baseName(f.name)}-cropped.pdf`, ['Cropping hides content outside the new box but does not delete it. Use Redact to remove content permanently.']);
};

const PAPER = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008] } as const;

const resize: Processor = async (ctx) => {
  const o = parseOptions('resize', ctx.options);
  const f = one(ctx);
  const src = await loadPdfFile(f.path, ctx.maxPages);
  const target = new Set(pages(o.pages, src.getPageCount()));
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(src.getPages());
  const [pw, ph] = PAPER[o.size];
  for (const [i, ep] of embedded.entries()) {
    const sp = src.getPage(i);
    const rot = ((sp.getRotation().angle % 360) + 360) % 360;
    const { width: W, height: H } = sp.getSize();
    if (!target.has(i)) {
      const p = out.addPage([W, H]); p.setRotation(degrees(rot)); p.drawPage(ep); continue;
    }
    const vw = rot % 180 ? H : W, vh = rot % 180 ? W : H;
    const [tw, th] = vw > vh ? [Math.max(pw, ph), Math.min(pw, ph)] : [Math.min(pw, ph), Math.max(pw, ph)];
    const s = Math.min(tw / vw, th / vh);
    const [PW, PH] = rot % 180 ? [th, tw] : [tw, th];
    const p = out.addPage([PW, PH]);
    p.setRotation(degrees(rot));
    p.drawPage(ep, { x: (PW - W * s) / 2, y: (PH - H * s) / 2, width: W * s, height: H * s });
  }
  return savePdf(ctx, out, `${baseName(f.name)}-${o.size}.pdf`, ['Links, form fields and annotations are not carried over when resizing.']);
};

const addBlankPages: Processor = async (ctx) => {
  const o = parseOptions('add-blank-pages', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const n = doc.getPageCount();
  const after = o.after === undefined ? n : o.after;
  if (after > n) throw new ToolError('invalid_options', `The document has only ${n} pages.`);
  if (n + o.count > ctx.maxPages) throw new ToolError('too_many_pages', `Result would exceed ${ctx.maxPages} pages.`);
  const ref = doc.getPage(Math.max(0, Math.min(after, n) - (after > 0 ? 1 : 0)));
  const { width, height } = ref.getSize();
  for (let k = 0; k < o.count; k++) doc.insertPage(after + k, [width, height]);
  return savePdf(ctx, doc, `${baseName(f.name)}-blank.pdf`);
};

const flatten: Processor = async (ctx) => {
  parseOptions('flatten', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const form = doc.getForm();
  const count = form.getFields().length;
  if (count === 0) throw new ToolError('no_form_fields', 'This PDF has no form fields to flatten.');
  form.flatten();
  return savePdf(ctx, doc, `${baseName(f.name)}-flattened.pdf`, ['Only form fields were flattened. Other annotations are left as they are.'], { fields: count });
};

// ------------------------------------------------------------ compare
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MAX_LINES = 20000;

const compare: Processor = async (ctx) => {
  parseOptions('compare', ctx.options);
  if (ctx.inputs.length !== 2) throw new ToolError('invalid_input', 'Select exactly two PDF files to compare.');
  const texts: string[] = [];
  for (const [i, f] of ctx.inputs.entries()) {
    await loadPdfFile(f.path, ctx.maxPages);
    const out = join(ctx.workDir, `t${i}.txt`);
    await runEngine(ctx, 'pdftotext', ['-layout', '-enc', 'UTF-8', f.path, out]);
    const t = (await readFile(out, 'utf8')).replace(/\r/g, '').replace(/\f/g, '\n');
    if (t.split('\n').length > MAX_LINES) throw new ToolError('too_large', 'These documents contain too much text to compare.');
    texts.push(t.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n'));
  }
  const parts = diffLines(texts[0]!, texts[1]!);
  let added = 0, removed = 0, same = 0;
  const body = parts.map((p) => {
    const n = p.count ?? 0;
    if (p.added) { added += n; return `<pre class="a">${esc(p.value)}</pre>`; }
    if (p.removed) { removed += n; return `<pre class="r">${esc(p.value)}</pre>`; }
    same += n; return n > 6 ? `<pre class="s">${esc(p.value.split('\n').slice(0, 3).join('\n'))}\n… ${n - 6} unchanged lines …\n${esc(p.value.trimEnd().split('\n').slice(-3).join('\n'))}</pre>` : `<pre class="s">${esc(p.value)}</pre>`;
  }).join('\n');
  const [a, b] = ctx.inputs.map((f) => esc(f.name));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PDF comparison</title><style>body{font:14px system-ui;margin:2rem}pre{margin:0;padding:2px 8px;white-space:pre-wrap}.a{background:#dcfce7}.r{background:#fee2e2;text-decoration:line-through}.s{color:#64748b}</style></head><body><h1>PDF text comparison</h1><p><b>Removed</b> (only in ${a}) / <b>Added</b> (only in ${b}). Text-only comparison; visual differences are not detected.</p><p>${added} lines added, ${removed} removed, ${same} unchanged.</p>${body}</body></html>`;
  const path = join(ctx.workDir, 'result.html');
  await writeFile(path, html);
  const identical = added === 0 && removed === 0;
  return {
    path, name: 'comparison.html', mime: 'text/html; charset=utf-8',
    warnings: identical ? ['The extracted text of both documents is identical (visual differences are not checked).'] : [],
    stats: { added, removed, unchanged: same },
  };
};

// ------------------------------------------------------------ repair
const repair: Processor = async (ctx) => {
  parseOptions('repair', ctx.options);
  const f = one(ctx);
  // Ghostscript turns arbitrary junk into a blank page; require at least some PDF object structure.
  const raw = (await readFile(f.path)).toString('latin1');
  if (!/%PDF-/.test(raw) || !/\bobj\b/.test(raw)) throw new ToolError('unrecoverable', 'This file does not contain recoverable PDF content.');
  const out = join(ctx.workDir, 'repaired.pdf');
  await runEngine(ctx, 'gs', ['-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER', '-dPDFSETTINGS=/prepress', `-sOutputFile=${out}`, f.path]).catch((e) => {
    if (e instanceof ToolError && e.code === 'engine_failed') throw new ToolError('unrecoverable', 'This PDF could not be repaired.');
    throw e;
  });
  let info;
  try { info = (await loadPdf(await readFile(out))).info; } catch { throw new ToolError('unrecoverable', 'This PDF could not be repaired.'); }
  if (info.pages === 0) throw new ToolError('unrecoverable', 'No pages could be recovered from this PDF.');
  return { path: out, name: `${baseName(f.name)}-repaired.pdf`, mime: PDF_MIME, warnings: ['Recovery is best-effort. Check the result for missing pages or content.'], stats: { pages: info.pages } };
};

export const TOOLS2: Partial<Record<ToolId, Processor>> = {
  'office-to-pdf': officeToPdf, protect, unlock,
  'pdf-to-text': pdfToText, 'pdf-to-html': pdfToHtml, 'extract-images': extractImages,
  crop, resize, 'add-blank-pages': addBlankPages, flatten, compare, repair,
};
