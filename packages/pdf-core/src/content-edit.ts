import { readFile } from 'node:fs/promises';
import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFRef, PDFStream, StandardFonts, degrees, rgb,
  type PDFContext, type PDFFont, type PDFImage, type PDFObject,
} from '@cantoo/pdf-lib';
import type { EditContentOptions } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import { assertImageSize, baseName, decodeFailure, one, parseOptions, savePdf, type Processor } from './helpers.js';
import { tokenize, hexString, num, type Op, type Tok } from './content-stream.js';
import { dictGet, familyOf, loadFont, look, nameOf, streamBytes, type FontInfo } from './pdf-fonts.js';
import { pageMapper } from './tools3.js';
import { reachableTags } from './pdf-graph.js';

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
/** a applied first, then b (row-vector convention used by PDF). */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

export interface Glyph {
  code: number; bytes: string; text: string;
  /** Horizontal advance (text-space units, includes Tc/Tw) used to keep following glyphs in place when this one is removed. */
  adv: number;
  box: [number, number, number, number];        // user space: x0 y0 x1 y1
  origin: [number, number]; angle: number; size: number; color: [number, number, number];
}
type Item = { g: Glyph } | { adj: number };
export interface ShowOp { op: Op; kind: string; items: Item[]; fs: number; th: number; tc: number; tw: number; font: FontInfo | undefined }
export interface ImageRef { name: string; ref: PDFRef; box: [number, number, number, number]; aspect: number; op: Op }
export interface PageAnalysis { src: string; ops: Op[]; shows: ShowOp[]; images: ImageRef[]; forms: number; inlineImages: number; resources: PDFDict | undefined }

const inherited = (ctx: PDFContext, page: PDFPage, key: string): PDFObject | undefined => {
  let n: PDFDict | undefined = page.node;
  for (let i = 0; n && i < 32; i++) {
    const v = look(ctx, n.get(PDFName.of(key)));
    if (v) return v;
    const p = look(ctx, n.get(PDFName.of('Parent')));
    n = p instanceof PDFDict ? p : undefined;
  }
  return undefined;
};

function contentOf(ctx: PDFContext, page: PDFPage): { src: string; refs: PDFRef[] } {
  const c = page.node.get(PDFName.of('Contents'));
  const parts: PDFObject[] = [];
  const refs: PDFRef[] = [];
  const push = (o: PDFObject | undefined) => { if (o instanceof PDFRef) refs.push(o); const r = look(ctx, o); if (r) parts.push(r); };
  const first = look(ctx, c);
  if (first instanceof PDFArray) for (let i = 0; i < first.size(); i++) push(first.get(i)); else push(c);
  const text = parts.filter((p): p is PDFStream => p instanceof PDFStream).map((s) => Buffer.from(streamBytes(s)).toString('latin1'));
  return { src: text.join('\n'), refs };
}

const colorOf = (op: string, a: Tok[]): [number, number, number] | undefined => {
  const n = a.filter((t): t is Extract<Tok, { t: 'num' }> => t.t === 'num').map((t) => t.v);
  if ((op === 'g' || (/^(sc|scn)$/.test(op) && n.length === 1)) && n.length === 1) return [n[0]!, n[0]!, n[0]!];
  if ((op === 'rg' || (/^(sc|scn)$/.test(op) && n.length === 3)) && n.length === 3) return [n[0]!, n[1]!, n[2]!];
  if ((op === 'k' || (/^(sc|scn)$/.test(op) && n.length === 4)) && n.length === 4) { const [c, m, y, k] = n as [number, number, number, number]; return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
  return undefined;
};

interface GS { ctm: M; font: FontInfo | undefined; fs: number; tc: number; tw: number; th: number; tl: number; rise: number; fill: [number, number, number] }

/** Walk a page's content: where every shown glyph and every image sits, in user space. */
export async function analyzePage(doc: PDFDocument, page: PDFPage): Promise<PageAnalysis> {
  const ctx = doc.context;
  const { src } = contentOf(ctx, page);
  const ops = tokenize(src);
  const resources = inherited(ctx, page, 'Resources');
  const res = resources instanceof PDFDict ? resources : undefined;

  const fonts = new Map<string, FontInfo>();
  const fd = dictGet(ctx, res, 'Font');
  if (fd instanceof PDFDict) {
    for (const [k, v] of fd.entries()) {
      const d = look(ctx, v);
      if (d instanceof PDFDict) fonts.set(k.decodeText(), await loadFont(ctx, d));
    }
  }
  const xo = dictGet(ctx, res, 'XObject');

  const shows: ShowOp[] = [];
  const images: ImageRef[] = [];
  let forms = 0, inlineImages = 0;
  let gs: GS = { ctm: I, font: undefined, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, fill: [0, 0, 0] };
  const stack: GS[] = [];
  let tm: M = I, tlm: M = I;

  const nums = (a: Tok[]) => a.filter((t): t is Extract<Tok, { t: 'num' }> => t.t === 'num').map((t) => t.v);
  const td = (tx: number, ty: number) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };

  const show = (op: Op, kind: string, parts: ({ s: string } | { n: number })[]) => {
    const font = gs.font;
    const items: Item[] = [];
    for (const p of parts) {
      if ('n' in p) { items.push({ adj: p.n }); tm = mul([1, 0, 0, 1, (-p.n / 1000) * gs.fs * gs.th, 0], tm); continue; }
      const codes = font ? font.codes(p.s) : [...p.s].map((c) => ({ code: c.charCodeAt(0), len: 1 }));
      let at = 0;
      for (const { code, len } of codes) {
        const bytes = p.s.slice(at, at + len); at += len;
        const w0 = font ? font.width(code) : 500;
        const trm = mul(mul([gs.fs * gs.th, 0, 0, gs.fs, 0, gs.rise], tm), gs.ctm);
        const wem = w0 / 1000;
        const pts = [apply(trm, 0, -0.2), apply(trm, wem, -0.2), apply(trm, wem, 0.8), apply(trm, 0, 0.8)];
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const adv = ((w0 / 1000) * gs.fs + gs.tc + (len === 1 && code === 32 ? gs.tw : 0)) * gs.th;
        items.push({
          g: {
            code, bytes, text: font ? font.uni(code) : '�', adv,
            box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
            origin: apply(trm, 0, 0), angle: (Math.atan2(trm[1], trm[0]) * 180) / Math.PI, size: Math.hypot(trm[0], trm[1]), color: gs.fill,
          },
        });
        tm = mul([1, 0, 0, 1, adv, 0], tm);
      }
    }
    shows.push({ op, kind, items, fs: gs.fs, th: gs.th, tc: gs.tc, tw: gs.tw, font });
  };

  for (const op of ops) {
    const a = op.args, n = nums(a);
    switch (op.op) {
      case 'q': stack.push({ ...gs }); break;
      case 'Q': { const s = stack.pop(); if (s) gs = s; break; }
      case 'cm': if (n.length === 6) gs = { ...gs, ctm: mul(n as M, gs.ctm) }; break;
      case 'BT': tm = I; tlm = I; break;
      case 'Tf': { const nm = a[0]?.t === 'name' ? a[0].v : ''; gs = { ...gs, font: fonts.get(nm), fs: n[0] ?? gs.fs }; break; }
      case 'Tc': gs = { ...gs, tc: n[0] ?? 0 }; break;
      case 'Tw': gs = { ...gs, tw: n[0] ?? 0 }; break;
      case 'Tz': gs = { ...gs, th: (n[0] ?? 100) / 100 }; break;
      case 'TL': gs = { ...gs, tl: n[0] ?? 0 }; break;
      case 'Ts': gs = { ...gs, rise: n[0] ?? 0 }; break;
      case 'Td': if (n.length === 2) td(n[0]!, n[1]!); break;
      case 'TD': if (n.length === 2) { gs = { ...gs, tl: -n[1]! }; td(n[0]!, n[1]!); } break;
      case 'Tm': if (n.length === 6) { tm = n as M; tlm = n as M; } break;
      case 'T*': td(0, -gs.tl); break;
      case 'Tj': if (a[0]?.t === 'str') show(op, 'Tj', [{ s: a[0].v }]); break;
      case 'TJ': if (a[0]?.t === 'arr') show(op, 'TJ', a[0].v.flatMap((t): ({ s: string } | { n: number })[] => (t.t === 'str' ? [{ s: t.v }] : t.t === 'num' ? [{ n: t.v }] : []))); break;
      case "'": td(0, -gs.tl); if (a[0]?.t === 'str') show(op, "'", [{ s: a[0].v }]); break;
      case '"': if (a[2]?.t === 'str') { gs = { ...gs, tw: n[0] ?? gs.tw, tc: n[1] ?? gs.tc }; td(0, -gs.tl); show(op, '"', [{ s: a[2].v }]); } break;
      case 'rg': case 'g': case 'k': case 'sc': case 'scn': { const c = colorOf(op.op, a); if (c) gs = { ...gs, fill: c }; break; }
      case 'BI': inlineImages++; break;
      case 'Do': {
        const nm = a[0]?.t === 'name' ? a[0].v : '';
        const raw = xo instanceof PDFDict ? xo.get(PDFName.of(nm)) : undefined;
        const obj = look(ctx, raw);
        const sub = obj instanceof PDFStream ? nameOf(look(ctx, obj.dict.get(PDFName.of('Subtype')))) : undefined;
        if (sub === 'Image' && raw instanceof PDFRef) {
          const pts = [apply(gs.ctm, 0, 0), apply(gs.ctm, 1, 0), apply(gs.ctm, 1, 1), apply(gs.ctm, 0, 1)];
          const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
          images.push({ name: nm, ref: raw, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], aspect: Math.hypot(gs.ctm[0], gs.ctm[1]) / (Math.hypot(gs.ctm[2], gs.ctm[3]) || 1), op });
        } else if (sub === 'Form') forms++;
        break;
      }
      default: break;
    }
  }
  return { src, ops, shows, images, forms, inlineImages, resources: res };
}

// ---------------------------------------------------------------- applying edits
type Rect = [number, number, number, number];
const rectOf = (page: PDFPage, e: { x: number; y: number; w: number; h: number }): Rect => {
  const { pt } = pageMapper(page);
  const c = [pt(e.x, e.y), pt(e.x + e.w, e.y), pt(e.x + e.w, e.y + e.h), pt(e.x, e.y + e.h)];
  return [Math.min(...c.map((p) => p.x)), Math.min(...c.map((p) => p.y)), Math.max(...c.map((p) => p.x)), Math.max(...c.map((p) => p.y))];
};
const inside = (r: Rect, x: number, y: number) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const iou = (a: Rect, b: Rect) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};

const FONT_STD = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
} as const;
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function rewriteShow(s: ShowOp, selected: Set<Glyph>): string {
  // Removed glyphs become kerning gaps of the same width so everything after them stays where it was.
  const parts: string[] = [];
  let cur = '';
  const flush = () => { if (cur) { parts.push(hexString(cur)); cur = ''; } };
  for (const it of s.items) {
    if ('adj' in it) { flush(); parts.push(num(it.adj)); continue; }
    if (!selected.has(it.g)) { cur += it.g.bytes; continue; }
    flush();
    const k = s.fs * s.th;
    if (k !== 0) parts.push(num((-it.g.adv * 1000) / k));
  }
  flush();
  const tj = `[${parts.join(' ')}] TJ`;
  if (s.kind === "'") return `T* ${tj}`;
  if (s.kind === '"') return `${num(s.tw)} Tw ${num(s.tc)} Tc T* ${tj}`;
  return tj;
}

interface Splice { start: number; end: number; text: string }

export const editContent: Processor = async (ctx) => {
  const o: EditContentOptions = parseOptions('edit-content', ctx.options);
  const [pdfIn, ...imageIn] = ctx.inputs;
  if (!pdfIn || pdfIn.kind !== 'pdf') throw new ToolError('invalid_input', 'The first file must be the PDF to edit.');
  if (imageIn.some((i) => i.kind !== 'jpg' && i.kind !== 'png')) throw new ToolError('invalid_input', 'Only JPG or PNG images can replace an image.');
  const doc = await loadPdfFile(pdfIn.path, ctx.maxPages);
  const n = doc.getPageCount();
  const pdfCtx = doc.context;

  const std = new Map<string, PDFFont>();
  const stdFont = async (fam: keyof typeof FONT_STD, bold: boolean, italic: boolean) => {
    const name = FONT_STD[fam][bold && italic ? 3 : bold ? 1 : italic ? 2 : 0];
    let f = std.get(name);
    if (!f) { f = await doc.embedFont(name); std.set(name, f); }
    return f;
  };
  const embedded = new Map<number, PDFImage>();
  const getImage = async (i: number) => {
    let img = embedded.get(i);
    if (img) return img;
    const f = imageIn[i];
    if (!f) throw new ToolError('invalid_options', `An edit refers to missing image #${i + 1}.`);
    const bytes = await readFile(f.path);
    assertImageSize(bytes, f.kind as 'jpg' | 'png', f.name);
    try { img = f.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes); } catch (e) { throw decodeFailure(e, f.name, f.kind); }
    embedded.set(i, img);
    return img;
  };

  const pagesTouched = new Set<number>([...o.textEdits.map((e) => e.page), ...o.imageEdits.map((e) => e.page)]);
  for (const p of pagesTouched) if (p >= n) throw new ToolError('invalid_options', `An edit is on page ${p + 1}, but the document has ${n} pages.`);

  const warnings: string[] = [];
  const stats = { textEdits: 0, glyphsRemoved: 0, imagesDeleted: 0, imagesReplaced: 0 };
  const orphanCandidates: PDFRef[] = [];
  const oldContentRefs: PDFRef[] = [];
  const draws: (() => Promise<void>)[] = [];

  let done = 0;
  for (const pi of [...pagesTouched].sort((a, b) => a - b)) {
    const page = doc.getPage(pi);
    const an = await analyzePage(doc, page);
    const splices: Splice[] = [];
    const removedFrom = new Map<ShowOp, Set<Glyph>>();
    const claimed = new Set<Glyph>();

    // ---- text
    for (const e of o.textEdits.filter((t) => t.page === pi)) {
      const r = rectOf(page, e);
      const hit: { show: ShowOp; g: Glyph }[] = [];
      for (const s of an.shows) for (const it of s.items) {
        if (!('g' in it) || claimed.has(it.g)) continue;
        const cx = (it.g.box[0] + it.g.box[2]) / 2, cy = (it.g.box[1] + it.g.box[3]) / 2;
        if (inside(r, cx, cy)) hit.push({ show: s, g: it.g });
      }
      if (!hit.length) {
        const why = an.forms || an.inlineImages ? ' Text inside embedded forms or inline images cannot be edited.' : '';
        throw new ToolError('text_not_found', `No editable text was found at the selected spot on page ${pi + 1}. It may be part of an image or drawn as shapes (scanned pages are not supported).${why}`);
      }
      const bad = hit.find((h) => h.show.font?.unsupported);
      if (bad) throw new ToolError('text_not_editable', `The text on page ${pi + 1} uses ${bad.show.font!.unsupported}, which cannot be edited safely.`);
      for (const h of hit) { claimed.add(h.g); (removedFrom.get(h.show) ?? removedFrom.set(h.show, new Set()).get(h.show)!).add(h.g); }
      const found = norm(hit.map((h) => h.g.text).join(''));
      if (e.original !== undefined && norm(e.original) !== '' && found !== norm(e.original)) {
        warnings.push(`On page ${pi + 1} the text under the selected box reads "${found.slice(0, 60)}", not "${norm(e.original).slice(0, 60)}". It was replaced anyway; check the result.`);
      }
      stats.textEdits++; stats.glyphsRemoved += hit.length;

      if (e.replacement !== '') {
        const first = hit[0]!;
        const fam = familyOf(first.show.font?.base ?? '');
        const family = e.font === 'auto' ? fam.family : e.font;
        const bold = e.bold ?? fam.bold, italic = e.italic ?? fam.italic;
        const size = e.size ?? Math.max(4, Math.round(first.g.size * 100) / 100);
        const color = e.color ? hex(e.color) : first.g.color.map((c) => Math.min(1, Math.max(0, c))) as [number, number, number];
        const text = e.replacement;
        // Overlap check for horizontal text: how far can the new text run before it meets the next glyph on the line?
        const horizontal = Math.abs(first.g.angle) < 1;
        const runEnd = Math.max(...hit.map((h) => h.g.box[2]));
        const lineY = first.g.origin[1];
        let limit = Math.max(...an.shows.flatMap((s) => s.items).flatMap((it) => ('g' in it ? [it.g.box[2]] : []))) + 1e9;
        if (horizontal) {
          limit = Infinity;
          for (const s of an.shows) for (const it of s.items) {
            if (!('g' in it) || claimed.has(it.g) || it.g.text.trim() === '') continue;
            if (Math.abs(it.g.origin[1] - lineY) < first.g.size * 0.5 && it.g.box[0] >= runEnd - 0.5) limit = Math.min(limit, it.g.box[0]);
          }
        }
        draws.push(async () => {
          const font = await stdFont(family, bold, italic);
          if (horizontal && Number.isFinite(limit) && first.g.origin[0] + font.widthOfTextAtSize(text.split('\n')[0]!, size) > limit + 0.5) {
            warnings.push(`On page ${pi + 1} the new text "${text.slice(0, 40)}" is wider than the space it replaces and overlaps the text after it. Shorten it, or edit the following words too.`);
          }
          const okSet = new Set(font.getCharacterSet());
          const missing = [...new Set([...text].filter((ch) => ch !== '\n' && !okSet.has(ch.codePointAt(0)!)))];
          if (missing.length) throw new ToolError('unsupported_text', `The replacement contains characters the standard PDF fonts cannot render (${missing.slice(0, 8).join(' ')}). Use Latin characters.`);
          page.drawText(text, { x: first.g.origin[0], y: first.g.origin[1], size, font, color: rgb(...color), rotate: degrees(first.g.angle), lineHeight: size * 1.2 });
        });
      }
    }
    for (const [s, set] of removedFrom) splices.push({ start: s.op.start, end: s.op.end, text: rewriteShow(s, set) });

    // ---- images
    const imgEdits = o.imageEdits.filter((t) => t.page === pi);
    if (imgEdits.length) {
      // Own the resource dictionaries: they may be shared with other pages, which must not lose their images.
      const base = an.resources ?? pdfCtx.obj({});
      const own = (base as PDFDict).clone(pdfCtx);
      const xo0 = dictGet(pdfCtx, own, 'XObject');
      const xo = xo0 instanceof PDFDict ? xo0.clone(pdfCtx) : pdfCtx.obj({});
      own.set(PDFName.of('XObject'), xo);
      page.node.set(PDFName.of('Resources'), own);
      const used = new Set<ImageRef>();
      let counter = 0;
      for (const e of imgEdits) {
        const r = rectOf(page, e);
        let best: ImageRef | undefined, bestScore = 0;
        for (const im of an.images) { if (used.has(im)) continue; const sc = iou(r, im.box); if (sc > bestScore) { bestScore = sc; best = im; } }
        if (!best || bestScore < 0.5) throw new ToolError('image_not_found', `No editable image was found at the selected spot on page ${pi + 1}. Only images placed directly on the page can be changed (not inline images or images inside embedded forms).`);
        used.add(best);
        if (e.action === 'delete') {
          splices.push({ start: best.op.start, end: best.op.end, text: '' });
          stats.imagesDeleted++;
        } else {
          const img = await getImage(e.imageIndex ?? 0);
          const nm = `PtImg${pi}x${counter++}`;
          xo.set(PDFName.of(nm), img.ref);
          let sx = 1, sy = 1;
          if (e.fit === 'contain') { const ia = img.width / img.height; if (ia > best.aspect) sy = best.aspect / ia; else sx = ia / best.aspect; }
          splices.push({ start: best.op.start, end: best.op.end, text: `q ${num(sx)} 0 0 ${num(sy)} ${num((1 - sx) / 2)} ${num((1 - sy) / 2)} cm /${nm} Do Q` });
          stats.imagesReplaced++;
        }
        orphanCandidates.push(best.ref);
      }
    }

    // ---- write the rewritten content stream
    let out = an.src;
    for (const sp of splices.sort((a, b) => b.start - a.start)) out = out.slice(0, sp.start) + sp.text + out.slice(sp.end);
    const { refs } = contentOf(pdfCtx, page);
    oldContentRefs.push(...refs);
    const stream = pdfCtx.stream(Buffer.from(out, 'latin1'));
    page.node.set(PDFName.of('Contents'), pdfCtx.register(stream));

    // drop name entries whose Do is gone from this page
    if (imgEdits.length) {
      const own = page.node.get(PDFName.of('Resources')) as PDFDict;
      const xo = dictGet(pdfCtx, own, 'XObject') as PDFDict;
      const still = new Set(tokenize(out).filter((p) => p.op === 'Do' && p.args[0]?.t === 'name').map((p) => (p.args[0] as { v: string }).v));
      for (const im of an.images) if (!still.has(im.name)) xo.delete(PDFName.of(im.name));
    }
    ctx.onProgress?.(Math.round((++done / pagesTouched.size) * 60));
  }

  for (const d of draws) await d();

  // ---- delete image objects (and their masks) that the document no longer reaches, plus our replaced content streams.
  // Reachability from the catalog is the test, not "is anything still pointing at it": the old shared resource
  // dictionary of a page we rewired still points at the image but no page can ever use it.
  const reachable = () => reachableTags(pdfCtx);
  let removedObjects = 0;
  const imageRefs = new Map(orphanCandidates.map((r) => [r.tag, r]));
  for (let round = 0; round < 4 && imageRefs.size; round++) {
    const live = reachable();
    const next = new Map<string, PDFRef>();
    for (const [tag, ref] of imageRefs) {
      if (live.has(tag)) continue;
      const obj = pdfCtx.lookup(ref);
      if (obj instanceof PDFStream) for (const k of ['SMask', 'Mask']) { const m = obj.dict.get(PDFName.of(k)); if (m instanceof PDFRef) next.set(m.tag, m); }
      pdfCtx.delete(ref); removedObjects++;
    }
    imageRefs.clear(); for (const [k, v] of next) imageRefs.set(k, v);
  }
  const live = reachable();
  for (const r of oldContentRefs) if (!live.has(r.tag)) pdfCtx.delete(r);

  if (an0(stats) === 0) throw new ToolError('invalid_options', 'Nothing was edited.');
  const parts: string[] = [];
  if (stats.textEdits) parts.push(`${stats.textEdits} text edit${stats.textEdits === 1 ? '' : 's'} (${stats.glyphsRemoved} characters removed from the page content)`);
  if (stats.imagesDeleted) parts.push(`${stats.imagesDeleted} image${stats.imagesDeleted === 1 ? '' : 's'} deleted`);
  if (stats.imagesReplaced) parts.push(`${stats.imagesReplaced} image${stats.imagesReplaced === 1 ? '' : 's'} replaced`);
  warnings.unshift(`${parts.join(', ')}. Replacement text uses a standard PDF font (Helvetica, Times or Courier) matched to the original, so letterforms can differ slightly; the original text is removed from the page, not covered.`);
  return savePdf(ctx, doc, `${baseName(one(ctx).name)}-edited.pdf`, warnings, { ...stats, imageObjectsRemoved: removedObjects });
};
const an0 = (s: { textEdits: number; imagesDeleted: number; imagesReplaced: number }) => s.textEdits + s.imagesDeleted + s.imagesReplaced;
