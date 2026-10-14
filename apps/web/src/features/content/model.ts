import type { EditContentOptions } from '@pdftools/shared';

export type Matrix = [number, number, number, number, number, number];
export interface FracBox { x: number; y: number; w: number; h: number }

/** a applied first, then b (PDF row-vector convention, same as pdf.js Util.transform(b, a)). */
export const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const pt = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function fracOf(xs: number[], ys: number[], vw: number, vh: number): FracBox {
  const x0 = clamp01(Math.min(...xs) / vw), x1 = clamp01(Math.max(...xs) / vw), y0 = clamp01(Math.min(...ys) / vh), y1 = clamp01(Math.max(...ys) / vh);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Box of one pdf.js text item as page fractions (as displayed, top-left origin).
 * `vp` is the scale-1 viewport transform, `item` the item's text matrix, `width` its advance in user-space units.
 */
export function textBox(vp: Matrix, vw: number, vh: number, item: Matrix, width: number): FracBox {
  const t = mul(item, vp);                 // item space -> viewport pixels at scale 1
  const len = Math.hypot(t[0], t[1]) || 1;
  const k = width / len;                    // item.width is in user units; convert to the item's own x axis
  const base = [t[4], t[5]] as const;
  const along = [t[0] * k, t[1] * k] as const;
  const up = [t[2], t[3]] as const;         // font-size vector, pointing "up" in glyph space
  const cs = [
    [base[0] - 0.2 * up[0], base[1] - 0.2 * up[1]],
    [base[0] + along[0] - 0.2 * up[0], base[1] + along[1] - 0.2 * up[1]],
    [base[0] + along[0] + 0.8 * up[0], base[1] + along[1] + 0.8 * up[1]],
    [base[0] + 0.8 * up[0], base[1] + 0.8 * up[1]],
  ];
  return fracOf(cs.map((c) => c[0]!), cs.map((c) => c[1]!), vw, vh);
}

/** Box of an image whose unit square is mapped by `ctm` (user space), as page fractions. */
export function imageBox(vp: Matrix, vw: number, vh: number, ctm: Matrix): FracBox {
  const m = mul(ctm, vp);
  const c = [pt(m, 0, 0), pt(m, 1, 0), pt(m, 1, 1), pt(m, 0, 1)];
  return fracOf(c.map((p) => p[0]), c.map((p) => p[1]), vw, vh);
}

export interface TextChange {
  page: number; box: FracBox; original: string; replacement: string;
  font: 'auto' | 'helvetica' | 'times' | 'courier'; bold: boolean | null; italic: boolean | null; size: number | null; color: string | null;
}
export interface ImageChange { page: number; box: FracBox; action: 'delete' | 'replace'; file?: File; fit: 'contain' | 'stretch' }

export interface ContentBuilt { options: EditContentOptions; images: File[]; count: number }

/** Convert editor state to API options. Replacement files are de-duplicated and re-indexed. */
export function buildContentPayload(texts: TextChange[], imgs: ImageChange[]): ContentBuilt {
  const files: File[] = [];
  const idx = (f: File) => { let i = files.indexOf(f); if (i < 0) { files.push(f); i = files.length - 1; } return i; };
  const textEdits = texts.map((t) => ({
    page: t.page, ...t.box, original: t.original, replacement: t.replacement, font: t.font,
    ...(t.bold !== null ? { bold: t.bold } : {}), ...(t.italic !== null ? { italic: t.italic } : {}),
    ...(t.size !== null ? { size: t.size } : {}), ...(t.color !== null ? { color: t.color } : {}),
  }));
  const imageEdits = imgs.filter((i) => i.action === 'delete' || i.file).map((i) => ({
    page: i.page, ...i.box, action: i.action, fit: i.fit, ...(i.action === 'replace' ? { imageIndex: idx(i.file!) } : {}),
  }));
  return { options: { textEdits, imageEdits } as EditContentOptions, images: files, count: textEdits.length + imageEdits.length };
}
