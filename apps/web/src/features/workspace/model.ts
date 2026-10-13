import type { Annotation, Redaction } from '@pdftools/shared';

export type Mode = 'edit' | 'sign' | 'redact';
export type A = Annotation & { id: string };
/** `type?: never` brands redactions so they are distinguishable from every annotation shape. */
export type R = Redaction & { id: string; type?: never };
export type Item = A | R;
export type Tool = 'select' | 'text' | 'rect' | 'ellipse' | 'line' | 'highlight' | 'draw' | 'image' | 'redact';

export const isRedaction = (i: Item): i is R => !('type' in i);
type Box = { x: number; y: number; w: number; h: number };
export const hasBox = (i: Item): i is Item & Box => 'w' in i;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function bounds(i: Item): Box {
  if (hasBox(i)) return { x: i.x, y: i.y, w: i.w, h: i.h };
  if (!isRedaction(i) && i.type === 'line') return { x: Math.min(i.x1, i.x2), y: Math.min(i.y1, i.y2), w: Math.abs(i.x2 - i.x1), h: Math.abs(i.y2 - i.y1) };
  if (!isRedaction(i) && i.type === 'draw') {
    const xs = i.points.map((p) => p[0]), ys = i.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** Translate an item by (du, dv) display fractions, clamped so it stays on the page. */
export function move<T extends Item>(item: T, du: number, dv: number): T {
  const b = bounds(item);
  const u = clamp(du, -b.x, 1 - b.x - b.w), v = clamp(dv, -b.y, 1 - b.y - b.h);
  if (hasBox(item)) return { ...item, x: item.x + u, y: item.y + v };
  if (!isRedaction(item) && item.type === 'line') return { ...item, x1: item.x1 + u, x2: item.x2 + u, y1: item.y1 + v, y2: item.y2 + v };
  if (!isRedaction(item) && item.type === 'draw') return { ...item, points: item.points.map(([x, y]) => [x + u, y + v] as [number, number]) };
  return item;
}

export const MIN_SIZE = 0.01;

/** Resize a box item from its bottom-right corner to (u, v). */
export function resizeTo<T extends Item>(item: T, u: number, v: number): T {
  if (!hasBox(item)) return item;
  return { ...item, w: clamp(u - item.x, MIN_SIZE, 1 - item.x), h: clamp(v - item.y, MIN_SIZE, 1 - item.y) };
}

export function normRect(a: [number, number], b: [number, number]): Box {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(Math.abs(a[0] - b[0]), 0, 1 - clamp(x, 0, 1)), h: clamp(Math.abs(a[1] - b[1]), 0, 1 - clamp(y, 0, 1)) };
}

/** Drop near-duplicate points from a freehand stroke to keep payloads small. */
export function simplify(points: [number, number][], minDist = 0.002): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  // A single tap must still produce a valid 2-point stroke (renders as a dot with round caps).
  const first = points[0];
  if (out.length < 2 && first) return [first, [Math.min(1, first[0] + 0.0005), first[1]]];
  return out;
}

export interface Built {
  options: Record<string, unknown>;
  /** Image files in the order the API expects them after the PDF. */
  images: File[];
  count: number;
}

/**
 * Convert editor state to API options. Image indices are re-packed so that only images actually
 * used are uploaded, and dedupe identical File objects.
 */
export function buildPayload(mode: Mode, items: Item[], imageFiles: File[], dpi: number): Built {
  if (mode === 'redact') {
    const redactions = items.filter(isRedaction).map(({ id: _id, ...r }) => r);
    return { options: { redactions, dpi }, images: [], count: redactions.length };
  }
  const used: number[] = [];
  const annotations = items.filter((i): i is A => !isRedaction(i)).map(({ id: _id, ...a }) => {
    if (a.type !== 'image') return a;
    let k = used.indexOf(a.imageIndex);
    if (k < 0) { used.push(a.imageIndex); k = used.length - 1; }
    return { ...a, imageIndex: k };
  });
  return { options: { annotations }, images: used.map((i) => imageFiles[i]!).filter(Boolean), count: annotations.length };
}
