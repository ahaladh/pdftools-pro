import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, BlendMode, LineCapStyle, degrees, rgb } from '@cantoo/pdf-lib';
import type { Annotation, ToolId } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import { assertImageSize, decodeFailure, runEngine, baseName, parseOptions, savePdf, type Processor } from './helpers.js';

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/**
 * Maps display fractions (u right, v down, relative to the page as shown after /Rotate and CropBox)
 * to user-space coordinates. `rot` is also the angle new content must be rotated (counter-clockwise)
 * so that it appears upright to the reader.
 */
export function pageMapper(page: PDFPage) {
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const b = page.getCropBox();
  const { x: X, y: Y, width: W, height: H } = b;
  const swap = rot === 90 || rot === 270;
  const vw = swap ? H : W, vh = swap ? W : H;
  const pt = (u: number, v: number) => {
    switch (rot) {
      case 90: return { x: X + v * W, y: Y + u * H };
      case 180: return { x: X + (1 - u) * W, y: Y + v * H };
      case 270: return { x: X + (1 - v) * W, y: Y + (1 - u) * H };
      default: return { x: X + u * W, y: Y + (1 - v) * H };
    }
  };
  return { rot, vw, vh, pt };
}

const FONT_NAMES = { helvetica: StandardFonts.Helvetica, times: StandardFonts.TimesRoman, courier: StandardFonts.Courier } as const;

const annotate: Processor = async (ctx) => {
  const tool = (ctx as { tool?: ToolId }).tool ?? 'edit';
  const o = parseOptions(tool === 'sign' ? 'sign' : 'edit', ctx.options);
  const [pdfIn, ...imageIn] = ctx.inputs;
  if (!pdfIn || pdfIn.kind !== 'pdf') throw new ToolError('invalid_input', 'The first file must be the PDF to edit.');
  if (imageIn.some((i) => i.kind !== 'jpg' && i.kind !== 'png')) throw new ToolError('invalid_input', 'Only JPG or PNG images can be placed on a page.');
  const doc = await loadPdfFile(pdfIn.path, ctx.maxPages);
  const n = doc.getPageCount();

  const fonts = new Map<string, PDFFont>();
  const getFont = async (k: keyof typeof FONT_NAMES) => { let f = fonts.get(k); if (!f) { f = await doc.embedFont(FONT_NAMES[k]); fonts.set(k, f); } return f; };
  const images = new Map<number, PDFImage>();
  const getImage = async (i: number) => {
    let img = images.get(i);
    if (img) return img;
    const f = imageIn[i];
    if (!f) throw new ToolError('invalid_options', `Annotation refers to missing image #${i + 1}.`);
    const bytes = await readFile(f.path);
    assertImageSize(bytes, f.kind as 'jpg' | 'png', f.name);
    try { img = f.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes); } catch (e) { throw decodeFailure(e, f.name, f.kind); }
    images.set(i, img);
    return img;
  };

  for (const [k, a] of (o.annotations as Annotation[]).entries()) {
    if (a.page >= n) throw new ToolError('invalid_options', `Annotation ${k + 1} is on page ${a.page + 1}, but the document has ${n} pages.`);
    const page = doc.getPage(a.page);
    const { rot, vw, vh, pt } = pageMapper(page);
    const rotate = degrees(rot);
    switch (a.type) {
      case 'text': {
        const font = await getFont(a.font);
        const ok = new Set(font.getCharacterSet());
        for (const ch of a.text) if (ch !== '\n' && !ok.has(ch.codePointAt(0)!)) throw new ToolError('unsupported_text', 'Text contains characters the standard PDF fonts cannot render. Use Latin characters.');
        const origin = pt(a.x, a.y + (a.fontSize * 0.945) / vh);
        page.drawText(a.text, { x: origin.x, y: origin.y, size: a.fontSize, font, color: hex(a.color), rotate, maxWidth: Math.max(a.w * vw, a.fontSize), lineHeight: a.fontSize * 1.2 });
        break;
      }
      case 'rect': {
        const o0 = pt(a.x, a.y + a.h);
        page.drawRectangle({
          x: o0.x, y: o0.y, width: a.w * vw, height: a.h * vh, rotate,
          color: a.fill ? hex(a.fill) : undefined, opacity: a.opacity,
          borderColor: a.stroke ? hex(a.stroke) : undefined, borderWidth: a.stroke ? a.strokeWidth : 0, borderOpacity: a.opacity,
        });
        break;
      }
      case 'ellipse': {
        const c = pt(a.x + a.w / 2, a.y + a.h / 2);
        page.drawEllipse({
          x: c.x, y: c.y, xScale: (a.w * vw) / 2, yScale: (a.h * vh) / 2, rotate,
          color: a.fill ? hex(a.fill) : undefined, opacity: a.opacity,
          borderColor: a.stroke ? hex(a.stroke) : undefined, borderWidth: a.stroke ? a.strokeWidth : 0, borderOpacity: a.opacity,
        });
        break;
      }
      case 'highlight': {
        const o0 = pt(a.x, a.y + a.h);
        page.drawRectangle({ x: o0.x, y: o0.y, width: a.w * vw, height: a.h * vh, rotate, color: hex(a.color), opacity: a.opacity, blendMode: BlendMode.Multiply });
        break;
      }
      case 'line':
        page.drawLine({ start: pt(a.x1, a.y1), end: pt(a.x2, a.y2), thickness: a.strokeWidth, color: hex(a.color), opacity: a.opacity, lineCap: LineCapStyle.Round });
        break;
      case 'draw':
        for (let i = 1; i < a.points.length; i++) {
          const p = a.points[i - 1]!, q = a.points[i]!;
          page.drawLine({ start: pt(p[0], p[1]), end: pt(q[0], q[1]), thickness: a.strokeWidth, color: hex(a.color), opacity: a.opacity, lineCap: LineCapStyle.Round });
        }
        break;
      case 'image': {
        const img = await getImage(a.imageIndex);
        const o0 = pt(a.x, a.y + a.h);
        page.drawImage(img, { x: o0.x, y: o0.y, width: a.w * vw, height: a.h * vh, rotate, opacity: a.opacity });
        break;
      }
    }
  }
  const label = tool === 'sign' ? 'signed' : 'edited';
  const warnings = tool === 'sign'
    ? ['This is a visual signature image only. It is not a certificate-based digital signature and has no cryptographic validation.']
    : ['Content was added on top of the existing pages. Existing PDF text was not changed.'];
  return savePdf(ctx, doc, `${baseName(pdfIn.name)}-${label}.pdf`, warnings, { annotations: o.annotations.length });
};

// ------------------------------------------------------------------ redaction
const MAX_PIXELS_PAGE = 100_000_000;

const redact: Processor = async (ctx) => {
  const o = parseOptions('redact', ctx.options);
  const f = ctx.inputs[0];
  if (!f || f.kind !== 'pdf' || ctx.inputs.length !== 1) throw new ToolError('invalid_input', 'Provide a single PDF to redact.');
  const src = await loadPdfFile(f.path, ctx.maxPages);
  const n = src.getPageCount();
  const byPage = new Map<number, typeof o.redactions>();
  for (const r of o.redactions) {
    if (r.page >= n) throw new ToolError('invalid_options', `A redaction is on page ${r.page + 1}, but the document has ${n} pages.`);
    byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  }
  const out = await PDFDocument.create();
  let done = 0;
  for (let i = 0; i < n; i++) {
    const rs = byPage.get(i);
    if (!rs) {
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p!);
      continue;
    }
    const { width, height } = src.getPage(i).getSize();
    if ((width / 72) * o.dpi * (height / 72) * o.dpi > MAX_PIXELS_PAGE) throw new ToolError('page_too_large', 'A page is too large to redact at this resolution. Choose a lower DPI.');
    const pg = String(i + 1);
    const stem = join(ctx.workDir, `rp-${pg}`);
    await runEngine(ctx, 'pdftoppm', ['-png', '-r', String(o.dpi), '-f', pg, '-l', pg, '-singlefile', f.path, stem]);
    const png = `${stem}.png`;
    const head = await readFile(png);
    const W = head.readUInt32BE(16), H = head.readUInt32BE(20);
    // Burn boxes into the pixels (1px bleed) so nothing underneath survives in the image data.
    const draw: string[] = [];
    for (const r of rs) {
      const x0 = Math.max(0, Math.floor(r.x * W) - 1), y0 = Math.max(0, Math.floor(r.y * H) - 1);
      const x1 = Math.min(W - 1, Math.ceil((r.x + r.w) * W)), y1 = Math.min(H - 1, Math.ceil((r.y + r.h) * H));
      draw.push('-draw', `rectangle ${x0},${y0} ${x1},${y1}`);
    }
    const burned = `${stem}-r.png`;
    await runEngine(ctx, 'convert', [png, '-fill', 'black', ...draw, '-strip', burned]);
    const img = await out.embedPng(await readFile(burned));
    const page = out.addPage([(W * 72) / o.dpi, (H * 72) / o.dpi]);
    page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    ctx.onProgress?.(Math.round((++done / byPage.size) * 90));
  }
  return savePdf(ctx, out, `${baseName(f.name)}-redacted.pdf`, [
    `${byPage.size} page${byPage.size === 1 ? ' was' : 's were'} converted to images with the marked areas burned in; the covered content was removed. Text on those pages is no longer selectable.`,
    'The output is a new document: original metadata, bookmarks and attachments were not carried over.',
  ], { pagesRedacted: byPage.size, areas: o.redactions.length });
};

export const TOOLS3: Partial<Record<ToolId, Processor>> = {
  edit: (ctx) => annotate({ ...ctx, tool: 'edit' } as typeof ctx),
  sign: (ctx) => annotate({ ...ctx, tool: 'sign' } as typeof ctx),
  redact,
};
