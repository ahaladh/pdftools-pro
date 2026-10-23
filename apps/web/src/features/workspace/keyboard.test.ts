import { describe, it, expect } from 'vitest';
import { annotationsOptions, redactOptions } from '@pdftools/shared';
import { bounds, isRedaction, type A, type R } from './model';
import { ADD_KINDS, describe as words, fields, kindOf, labels, newItem, nudge, setField, type AddKind, type Style } from './keyboard';

const style: Style = { color: '#111827', stroke: '#dc2626', fill: null, strokeWidth: 2, opacity: 1, fontSize: 16, font: 'helvetica', highlight: '#fde047' };
const strip = (i: A | R) => { const { id: _id, ...rest } = i; return rest; };

describe('adding without a pointer', () => {
  it('every kind produces exactly what the API accepts, on the right page, inside the page', () => {
    for (const k of ['rect', 'ellipse', 'line', 'highlight', 'text', 'image'] as AddKind[]) {
      const item = newItem(k, 3, style, 'id1', 2) as A;
      expect(item.page).toBe(3);
      const parsed = annotationsOptions.safeParse({ annotations: [strip(item)] });
      expect(parsed.success, `${k}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      const b = bounds(item); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(1); expect(b.y + b.h).toBeLessThanOrEqual(1);
    }
    const red = newItem('redact', 1, style, 'r1') as R;
    expect(isRedaction(red)).toBe(true);
    expect(redactOptions.safeParse({ redactions: [strip(red)] }).success).toBe(true);
  });
  it('uses the current drawing style, and the image the person chose', () => {
    expect(newItem('rect', 0, { ...style, stroke: '#00ff00', fill: '#0000ff', strokeWidth: 5 }, 'a')).toMatchObject({ stroke: '#00ff00', fill: '#0000ff', strokeWidth: 5 });
    expect(newItem('highlight', 0, { ...style, highlight: '#abcdef' }, 'a')).toMatchObject({ color: '#abcdef' });
    expect(newItem('image', 0, style, 'a', 4)).toMatchObject({ imageIndex: 4 });
    expect(newItem('text', 0, { ...style, fontSize: 30, font: 'courier' }, 'a')).toMatchObject({ fontSize: 30, font: 'courier', text: 'Text' });
  });
  it('offers each kind only where it makes sense (redaction areas only when redacting, freehand never)', () => {
    const ids = (m: 'edit' | 'sign' | 'redact') => ADD_KINDS.filter((k) => k.modes.includes(m)).map((k) => k.id);
    expect(ids('redact')).toEqual(['redact']); expect(ids('sign')).toEqual(['text', 'image']);
    expect(ids('edit')).toEqual(['rect', 'ellipse', 'line', 'highlight', 'text', 'image']);
    expect(ADD_KINDS.map((k) => k.id)).not.toContain('draw' as never);
  });
});

describe('naming and describing items', () => {
  it('numbers items within their kind so a list is unambiguous', () => {
    const items = [newItem('rect', 0, style, 'a'), newItem('line', 0, style, 'b'), newItem('rect', 0, style, 'c'), newItem('redact', 0, style, 'd')];
    expect(labels(items)).toEqual(['Rectangle 1', 'Line 1', 'Rectangle 2', 'Redaction area 1']);
    expect(kindOf({ id: 'x', type: 'draw', page: 0, points: [[0, 0], [1, 1]], color: '#000000', strokeWidth: 1, opacity: 1 } as A)).toBe('Freehand stroke');
  });
  it('says where an item is in plain words', () => {
    expect(words(newItem('rect', 0, style, 'a'))).toBe('at 35% across, 40% down, 30% wide, 12% tall');
    expect(words(newItem('line', 0, style, 'a'))).toBe('from 30% across, 50% down to 70% across, 50% down');
  });
});

describe('typing positions', () => {
  const rect = () => newItem('rect', 0, style, 'a') as A & { x: number; y: number; w: number; h: number };
  it('lists the fields that place each kind of item', () => {
    expect(fields(rect()).map((f) => f.label)).toEqual(['Across (%)', 'Down (%)', 'Width (%)', 'Height (%)']);
    expect(fields(newItem('line', 0, style, 'a')).map((f) => f.key)).toEqual(['x1', 'y1', 'x2', 'y2']);
    expect(fields({ id: 'd', type: 'draw', page: 0, points: [[0.1, 0.2], [0.3, 0.4]], color: '#000000', strokeWidth: 1, opacity: 1 } as A)).toEqual([{ key: 'x', label: 'Across (%)', value: 10 }, { key: 'y', label: 'Down (%)', value: 20 }]);
  });
  it('sets a value in percent and keeps the item on the page', () => {
    expect(setField(rect(), 'x', 10)).toMatchObject({ x: 0.1 });
    expect(setField(rect(), 'x', 95)).toMatchObject({ x: expect.closeTo(0.7) }); // 95% would push the right edge off the page: held at the edge
    expect(setField(rect(), 'w', 90)).toMatchObject({ w: expect.closeTo(0.65) }); // cannot extend past the page from where it starts
    expect(setField(rect(), 'x', -20)).toMatchObject({ x: 0 });
    expect(setField(rect(), 'h', 0)).toMatchObject({ h: 0.01 }); // never smaller than the minimum
    expect(setField(rect(), 'x', Number.NaN)).toEqual(rect());
    expect(setField(rect(), 'nope', 5)).toEqual(rect());
  });
  it('moves lines by endpoint and freehand strokes as a whole', () => {
    expect(setField(newItem('line', 0, style, 'a') as A, 'y2', 80)).toMatchObject({ y2: 0.8, y1: 0.5 });
    const d = { id: 'd', type: 'draw', page: 0, points: [[0.1, 0.2], [0.3, 0.4]], color: '#000000', strokeWidth: 1, opacity: 1 } as A & { points: [number, number][] };
    expect(setField(d, 'x', 50).points).toEqual([[expect.closeTo(0.5), 0.2], [expect.closeTo(0.7), 0.4]]);
  });
});

describe('arrow keys', () => {
  const rect = () => newItem('rect', 0, style, 'a') as A & { x: number; y: number; w: number; h: number };
  it('move by 1% (5% with Shift), in the direction pressed, and stop at the page edge', () => {
    expect(nudge(rect(), 'ArrowRight')).toMatchObject({ x: expect.closeTo(0.36) });
    expect(nudge(rect(), 'ArrowLeft', { big: true })).toMatchObject({ x: expect.closeTo(0.3) });
    expect(nudge(rect(), 'ArrowUp')).toMatchObject({ y: expect.closeTo(0.39) });
    expect(nudge(rect(), 'ArrowDown', { big: true })).toMatchObject({ y: expect.closeTo(0.45) });
    let r = rect(); for (let i = 0; i < 100; i++) r = nudge(r, 'ArrowRight', { big: true });
    expect(r.x + r.w).toBeCloseTo(1); // held at the right edge, not pushed through it
    r = rect(); for (let i = 0; i < 100; i++) r = nudge(r, 'ArrowUp', { big: true });
    expect(r.y).toBe(0);
  });
  it('with Alt change the size (a line\'s end point), within the page and above the minimum', () => {
    expect(nudge(rect(), 'ArrowRight', { resize: true })).toMatchObject({ w: expect.closeTo(0.31), x: 0.35 });
    expect(nudge(rect(), 'ArrowUp', { resize: true, big: true })).toMatchObject({ h: expect.closeTo(0.07) });
    let r = rect(); for (let i = 0; i < 100; i++) r = nudge(r, 'ArrowLeft', { resize: true, big: true });
    expect(r.w).toBe(0.01);
    expect(nudge(newItem('line', 0, style, 'a') as A, 'ArrowDown', { resize: true })).toMatchObject({ y2: expect.closeTo(0.51), y1: 0.5, x2: 0.7 });
    const d = { id: 'd', type: 'draw', page: 0, points: [[0.1, 0.2], [0.3, 0.4]], color: '#000000', strokeWidth: 1, opacity: 1 } as A;
    expect(nudge(d, 'ArrowRight', { resize: true })).toBe(d);
  });
  it('move lines and strokes as a unit', () => {
    expect(nudge(newItem('line', 0, style, 'a') as A, 'ArrowRight', { big: true })).toMatchObject({ x1: expect.closeTo(0.35), x2: expect.closeTo(0.75) });
  });
});
