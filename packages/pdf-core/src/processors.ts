import { readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb, PDFName } from '@cantoo/pdf-lib';
import {
  optionSchemas, parsePageRanges, parsePageSequence,
  type ToolId, type ToolOptions,
} from '@pdftools/shared';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import type { ProcessContext, ProcessResult } from './types.js';

import { assertImageSize, decodeFailure, runEngine, PDF_MIME, baseName, savePdf, one, parseOptions, pages, zipResult, type Processor } from './helpers.js';

// ---------------------------------------------------------------- merge
const merge: Processor = async (ctx) => {
  parseOptions('merge', ctx.options);
  if (ctx.inputs.length < 2) throw new ToolError('invalid_input', 'Select at least two PDF files to merge.');
  const out = await PDFDocument.create();
  let total = 0;
  for (const [i, f] of ctx.inputs.entries()) {
    const src = await loadPdfFile(f.path, ctx.maxPages);
    total += src.getPageCount();
    if (total > ctx.maxPages) throw new ToolError('too_many_pages', `Merged document would exceed ${ctx.maxPages} pages.`);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    ctx.onProgress?.(Math.round(((i + 1) / ctx.inputs.length) * 90));
  }
  return savePdf(ctx, out, 'merged.pdf', ['Bookmarks and interactive form data from the source files are not preserved.']);
};

// ---------------------------------------------------------------- split
const split: Processor = async (ctx) => {
  const o = parseOptions('split', ctx.options);
  const f = one(ctx);
  const src = await loadPdfFile(f.path, ctx.maxPages);
  const n = src.getPageCount();
  let groups: number[][];
  if (o.mode === 'each') groups = src.getPageIndices().map((i) => [i]);
  else if (o.mode === 'every') {
    groups = [];
    for (let i = 0; i < n; i += o.every) groups.push(src.getPageIndices().slice(i, i + o.every));
  } else {
    if (!o.ranges.trim()) throw new ToolError('invalid_options', 'Enter at least one page range.');
    // Each comma-separated part becomes its own output file.
    groups = o.ranges.split(',').map((part) => pages(part, n));
  }
  const entries: { name: string; data: Uint8Array }[] = [];
  const base = baseName(f.name);
  for (const [gi, g] of groups.entries()) {
    const doc = await PDFDocument.create();
    for (const p of await doc.copyPages(src, g)) doc.addPage(p);
    entries.push({ name: `${base}-part${String(gi + 1).padStart(3, '0')}.pdf`, data: await doc.save() });
    ctx.onProgress?.(Math.round(((gi + 1) / groups.length) * 90));
  }
  if (entries.length === 1) {
    const path = join(ctx.workDir, 'result.pdf');
    await writeFile(path, entries[0]!.data);
    return { path, name: entries[0]!.name, mime: PDF_MIME, warnings: [], stats: { files: 1 } };
  }
  const r = await zipResult(ctx, entries, `${base}-split.zip`, 0);
  r.stats = { files: entries.length };
  return r;
};

// ---------------------------------------------------------------- compress
const GS_PRESET = { 'maximum-quality': '/prepress', recommended: '/ebook', 'maximum-compression': '/screen' } as const;

const compress: Processor = async (ctx) => {
  const o = parseOptions('compress', ctx.options);
  const f = one(ctx);
  await loadPdfFile(f.path, ctx.maxPages); // validates
  const out = join(ctx.workDir, 'compressed.pdf');
  await runEngine(ctx, 'gs', [
    '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${GS_PRESET[o.preset]}`,
    '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER', '-dDetectDuplicateImages=true',
    `-sOutputFile=${out}`, f.path,
  ]);
  ctx.onProgress?.(85);

  const before = (await stat(f.path)).size;
  const warnings: string[] = [];
  let resultPath = out;
  if ((await stat(out)).size >= before) {
    // Never hand back a bigger file than the user uploaded.
    resultPath = join(ctx.workDir, 'original-copy.pdf');
    await copyFile(f.path, resultPath);
    warnings.push('This file is already well optimized; the original was returned unchanged.');
  }
  if (o.stripMetadata) {
    // Applied to whichever file is returned, so the option is honoured on the fallback path too.
    const doc = await PDFDocument.load(await readFile(resultPath), { updateMetadata: false });
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]);
    doc.setProducer(''); doc.setCreator('');
    doc.catalog.delete(PDFName.of('Metadata'));
    await writeFile(resultPath, await doc.save());
  }
  const finalSize = (await stat(resultPath)).size;
  return {
    path: resultPath, name: `${baseName(f.name)}-compressed.pdf`, mime: PDF_MIME, warnings,
    stats: {
      originalBytes: before, compressedBytes: finalSize,
      reductionPercent: Number((((before - finalSize) / before) * 100).toFixed(1)),
    },
  };
};

// ---------------------------------------------------------------- rotate
const rotate: Processor = async (ctx) => {
  const o = parseOptions('rotate', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  for (const i of pages(o.pages, doc.getPageCount())) {
    const p = doc.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + o.angle) % 360));
  }
  return savePdf(ctx, doc, `${baseName(f.name)}-rotated.pdf`);
};

// ---------------------------------------------------------------- organize
const organize: Processor = async (ctx) => {
  const o = parseOptions('organize', ctx.options);
  const f = one(ctx);
  const src = await loadPdfFile(f.path, ctx.maxPages);
  let seq: number[];
  try { seq = parsePageSequence(o.order, src.getPageCount()); } catch (e) { throw new ToolError('invalid_options', (e as Error).message); }
  if (seq.length > ctx.maxPages) throw new ToolError('too_many_pages', `Result would exceed ${ctx.maxPages} pages.`);
  const out = await PDFDocument.create();
  // copyPages one-by-one so the same source page can appear several times.
  for (const [pos, idx] of seq.entries()) {
    const [page] = await out.copyPages(src, [idx]);
    const extra = o.rotations[String(pos + 1)] ?? 0;
    page!.setRotation(degrees((page!.getRotation().angle + extra) % 360));
    out.addPage(page!);
  }
  return savePdf(ctx, out, `${baseName(f.name)}-organized.pdf`);
};

// ---------------------------------------------------------------- extract
const extractPages: Processor = async (ctx) => {
  const o = parseOptions('extract-pages', ctx.options);
  const f = one(ctx);
  const src = await loadPdfFile(f.path, ctx.maxPages);
  const idx = pages(o.pages, src.getPageCount());
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, idx)) out.addPage(p);
  return savePdf(ctx, out, `${baseName(f.name)}-extracted.pdf`);
};

// ---------------------------------------------------------------- text helpers
const hexColor = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

function assertEncodable(font: { getCharacterSet(): number[] }, text: string) {
  const ok = new Set(font.getCharacterSet());
  for (const ch of text) {
    if (!ok.has(ch.codePointAt(0)!)) {
      throw new ToolError('unsupported_text', 'Text contains characters the built-in font cannot render. Use Latin characters (WinAnsi).');
    }
  }
}

// ---------------------------------------------------------------- page numbers
const pageNumbers: Processor = async (ctx) => {
  const o = parseOptions('page-numbers', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const total = doc.getPageCount();
  const target = new Set(pages(o.pages, total));
  const margin = 28;
  for (const i of target) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    const n = o.start + i;
    const text = o.format === 'n' ? `${n}` : o.format === 'page-n' ? `Page ${n}` : `${n} of ${total + o.start - 1}`;
    const w = font.widthOfTextAtSize(text, o.fontSize);
    const [v, h] = o.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right'];
    const x = h === 'left' ? margin : h === 'right' ? width - margin - w : (width - w) / 2;
    const y = v === 'bottom' ? margin : height - margin - o.fontSize;
    page.drawText(text, { x, y, size: o.fontSize, font, color: rgb(0.2, 0.2, 0.2) });
  }
  return savePdf(ctx, doc, `${baseName(f.name)}-numbered.pdf`);
};

// ---------------------------------------------------------------- watermark
const watermark: Processor = async (ctx) => {
  const o = parseOptions('watermark', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  assertEncodable(font, o.text);
  const w = font.widthOfTextAtSize(o.text, o.fontSize);
  const h = font.heightAtSize(o.fontSize, { descender: false });
  const rad = (o.rotation * Math.PI) / 180;
  for (const i of pages(o.pages, doc.getPageCount())) {
    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    // Rotation happens about the text origin; offset it so the text is centred on the page.
    const cx = width / 2, cy = height / 2;
    const x = cx - (w / 2) * Math.cos(rad) + (h / 2) * Math.sin(rad);
    const y = cy - (w / 2) * Math.sin(rad) - (h / 2) * Math.cos(rad);
    page.drawText(o.text, { x, y, size: o.fontSize, font, color: hexColor(o.color), opacity: o.opacity, rotate: degrees(o.rotation) });
  }
  return savePdf(ctx, doc, `${baseName(f.name)}-watermarked.pdf`);
};

// ---------------------------------------------------------------- images -> pdf
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

const imagesToPdf: Processor = async (ctx) => {
  const o = parseOptions('images-to-pdf', ctx.options);
  if (ctx.inputs.length === 0) throw new ToolError('invalid_input', 'Select at least one image.');
  if (ctx.inputs.length > ctx.maxPages) throw new ToolError('too_many_pages', `Too many images (limit ${ctx.maxPages}).`);
  const doc = await PDFDocument.create();
  for (const [i, f] of ctx.inputs.entries()) {
    const bytes = await readFile(f.path);
    if (f.kind === 'jpg' || f.kind === 'png') assertImageSize(bytes, f.kind, f.name);
    let img;
    try { img = f.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes); } catch (e) { throw decodeFailure(e, f.name, f.kind); }
    const m = o.margin;
    const [pw, ph] = o.pageSize === 'fit' ? [img.width + m * 2, img.height + m * 2] : SIZES[o.pageSize];
    const page = doc.addPage([pw, ph]);
    const scale = Math.min((pw - m * 2) / img.width, (ph - m * 2) / img.height, o.pageSize === 'fit' ? 1 : Infinity);
    const dw = img.width * scale, dh = img.height * scale;
    page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
    ctx.onProgress?.(Math.round(((i + 1) / ctx.inputs.length) * 90));
  }
  return savePdf(ctx, doc, 'images.pdf');
};

// ---------------------------------------------------------------- pdf -> images
const MAX_PIXELS_PAGE = 100_000_000; // guards against huge pages at high DPI

const pdfToImages: Processor = async (ctx) => {
  const o = parseOptions('pdf-to-images', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const idx = pages(o.pages, doc.getPageCount());
  for (const i of idx) {
    const { width, height } = doc.getPage(i).getSize();
    if ((width / 72) * o.dpi * (height / 72) * o.dpi > MAX_PIXELS_PAGE) {
      throw new ToolError('page_too_large', 'A page is too large to render at this DPI. Choose a lower resolution.');
    }
  }
  const ext = o.format;
  const flag = o.format === 'jpg' ? '-jpeg' : '-png';
  for (const [k, i] of idx.entries()) {
    const pg = String(i + 1);
    await runEngine(ctx, 'pdftoppm', [flag, '-r', String(o.dpi), '-f', pg, '-l', pg, '-singlefile', f.path, join(ctx.workDir, `page-${pg.padStart(4, '0')}`)]);
    ctx.onProgress?.(Math.round(((k + 1) / idx.length) * 90));
  }
  const files = (await readdir(ctx.workDir)).filter((n) => n.startsWith('page-') && n.endsWith(`.${ext}`)).sort();
  if (files.length === 0) throw new ToolError('engine_failed', 'No images were produced.');
  const base = baseName(f.name);
  if (files.length === 1) {
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
    return { path: join(ctx.workDir, files[0]!), name: `${base}-page${idx[0]! + 1}.${ext}`, mime, warnings: [], stats: { images: 1 } };
  }
  const entries = await Promise.all(files.map(async (n) => ({ name: `${base}-${n}`, data: new Uint8Array(await readFile(join(ctx.workDir, n))) })));
  const r = await zipResult(ctx, entries, `${base}-images.zip`, 0);
  r.stats = { images: files.length };
  return r;
};

import { TOOLS2 } from './tools2.js';
import { TOOLS3 } from './tools3.js';
import { CONVERT } from './convert.js';
import { editContent } from './content-edit.js';
import { processBatch } from './batch.js';
import { OCR_TOOLS } from './ocr.js';
import { PDFA_TOOLS } from './pdfa.js';

const CORE: Partial<Record<ToolId, Processor>> = {
  merge, split, compress, rotate, organize,
  'extract-pages': extractPages,
  'page-numbers': pageNumbers,
  watermark,
  'images-to-pdf': imagesToPdf,
  'pdf-to-images': pdfToImages,
};

export const PROCESSORS = { ...CORE, ...TOOLS2, ...TOOLS3, ...CONVERT, 'edit-content': editContent, ...OCR_TOOLS, ...PDFA_TOOLS } as Record<ToolId, Processor>;

export async function processTool(tool: ToolId, ctx: ProcessContext): Promise<ProcessResult> {
  const c = { ...ctx, deadline: ctx.deadline ?? Date.now() + ctx.timeoutMs };
  return ctx.batch ? processBatch(tool, c, PROCESSORS[tool]) : PROCESSORS[tool](c);
}
