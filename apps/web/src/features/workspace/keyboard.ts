import { bounds, hasBox, isRedaction, move, MIN_SIZE, type A, type Item, type Mode, type R } from './model';

/** What a person can add without a pointer. Freehand needs a stroke drawn with a pointer, so it is not offered. */
export type AddKind = 'rect' | 'ellipse' | 'line' | 'highlight' | 'text' | 'redact' | 'image';

export const ADD_KINDS: { id: AddKind; label: string; modes: Mode[] }[] = [
  { id: 'redact', label: 'Redaction area', modes: ['redact'] },
  { id: 'rect', label: 'Rectangle', modes: ['edit'] },
  { id: 'ellipse', label: 'Ellipse', modes: ['edit'] },
  { id: 'line', label: 'Line', modes: ['edit'] },
  { id: 'highlight', label: 'Highlight', modes: ['edit'] },
  { id: 'text', label: 'Text', modes: ['edit', 'sign'] },
  { id: 'image', label: 'The chosen image', modes: ['edit', 'sign'] },
];

export interface Style { color: string; stroke: string; fill: string | null; strokeWidth: number; opacity: number; fontSize: number; font: 'helvetica' | 'times' | 'courier'; highlight: string }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (f: number) => Math.round(f * 1000) / 10;

/** A new item of the given kind, centred on the page at a sensible size, in the current drawing style. All coordinates are page fractions. */
export function newItem(kind: AddKind, page: number, d: Style, id: string, imageIndex = 0): Item {
  switch (kind) {
    case 'redact': return { id, page, x: 0.3, y: 0.44, w: 0.4, h: 0.06 } as R;
    case 'rect': case 'ellipse': return { id, type: kind, page, x: 0.35, y: 0.4, w: 0.3, h: 0.12, stroke: d.stroke, fill: d.fill, strokeWidth: d.strokeWidth, opacity: d.opacity } as A;
    case 'highlight': return { id, type: 'highlight', page, x: 0.3, y: 0.45, w: 0.4, h: 0.03, color: d.highlight, opacity: 0.45 } as A;
    case 'line': return { id, type: 'line', page, x1: 0.3, y1: 0.5, x2: 0.7, y2: 0.5, color: d.color, strokeWidth: d.strokeWidth, opacity: d.opacity } as A;
    case 'text': return { id, type: 'text', page, x: 0.3, y: 0.45, w: 0.4, h: 0.05, text: 'Text', fontSize: d.fontSize, color: d.color, font: d.font } as A;
    case 'image': return { id, type: 'image', page, x: 0.35, y: 0.4, w: 0.3, h: 0.2, imageIndex, opacity: 1 } as A;
  }
}

export function kindOf(i: Item): string {
  if (isRedaction(i)) return 'Redaction area';
  return { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', highlight: 'Highlight', text: 'Text', draw: 'Freehand stroke', image: 'Image' }[(i as A).type];
}

/** "Rectangle 2": the kind and its position among items of that kind on the same page, so every entry in a list is distinguishable. */
export function labels(items: Item[]): string[] {
  const seen = new Map<string, number>();
  return items.map((i) => { const k = kindOf(i); const n = (seen.get(k) ?? 0) + 1; seen.set(k, n); return `${k} ${n}`; });
}

/** Position in words for a screen reader (and for a sighted person who prefers numbers). */
export function describe(i: Item): string {
  if (!isRedaction(i) && i.type === 'line') return `from ${pct(i.x1)}% across, ${pct(i.y1)}% down to ${pct(i.x2)}% across, ${pct(i.y2)}% down`;
  const b = bounds(i);
  if (!isRedaction(i) && i.type === 'draw') return `at ${pct(b.x)}% across, ${pct(b.y)}% down`;
  return `at ${pct(b.x)}% across, ${pct(b.y)}% down, ${pct(b.w)}% wide, ${pct(b.h)}% tall`;
}

export interface Field { key: string; label: string; value: number }

/** The numeric fields that place an item, in percent of the page. A freehand stroke can only be moved. */
export function fields(i: Item): Field[] {
  if (hasBox(i)) return [{ key: 'x', label: 'Across (%)', value: pct(i.x) }, { key: 'y', label: 'Down (%)', value: pct(i.y) }, { key: 'w', label: 'Width (%)', value: pct(i.w) }, { key: 'h', label: 'Height (%)', value: pct(i.h) }];
  if (!isRedaction(i) && i.type === 'line') return [{ key: 'x1', label: 'Start across (%)', value: pct(i.x1) }, { key: 'y1', label: 'Start down (%)', value: pct(i.y1) }, { key: 'x2', label: 'End across (%)', value: pct(i.x2) }, { key: 'y2', label: 'End down (%)', value: pct(i.y2) }];
  const b = bounds(i);
  return [{ key: 'x', label: 'Across (%)', value: pct(b.x) }, { key: 'y', label: 'Down (%)', value: pct(b.y) }];
}

/** Set one field from a percentage the person typed. Keeps the item on the page and a box at least the minimum size. */
export function setField<T extends Item>(item: T, key: string, percent: number): T {
  if (!Number.isFinite(percent)) return item;
  const v = clamp(percent / 100, 0, 1);
  if (hasBox(item)) {
    if (key === 'x') return { ...item, x: clamp(v, 0, 1 - item.w) };
    if (key === 'y') return { ...item, y: clamp(v, 0, 1 - item.h) };
    if (key === 'w') return { ...item, w: clamp(v, MIN_SIZE, 1 - item.x) };
    if (key === 'h') return { ...item, h: clamp(v, MIN_SIZE, 1 - item.y) };
    return item;
  }
  if (!isRedaction(item) && item.type === 'line') return (['x1', 'y1', 'x2', 'y2'].includes(key) ? { ...item, [key]: v } : item) as T;
  if (!isRedaction(item) && item.type === 'draw') {
    const b = bounds(item);
    if (key === 'x') return move(item, clamp(v, 0, 1 - b.w) - b.x, 0);
    if (key === 'y') return move(item, 0, clamp(v, 0, 1 - b.h) - b.y);
  }
  return item;
}

export type Arrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
export const NUDGE = 0.01, NUDGE_BIG = 0.05;

/** An arrow key on the selected item: moves it, or (with `resize`) changes its width/height (a line's end point). One step is 1% of the page, 5% with Shift. */
export function nudge<T extends Item>(item: T, key: Arrow, o: { big?: boolean; resize?: boolean } = {}): T {
  const s = o.big ? NUDGE_BIG : NUDGE;
  const du = key === 'ArrowLeft' ? -s : key === 'ArrowRight' ? s : 0, dv = key === 'ArrowUp' ? -s : key === 'ArrowDown' ? s : 0;
  if (!o.resize) return move(item, du, dv);
  if (hasBox(item)) return { ...item, w: clamp(item.w + du, MIN_SIZE, 1 - item.x), h: clamp(item.h + dv, MIN_SIZE, 1 - item.y) };
  if (!isRedaction(item) && item.type === 'line') return { ...item, x2: clamp(item.x2 + du, 0, 1), y2: clamp(item.y2 + dv, 0, 1) };
  return item; // a freehand stroke has no size to change
}
