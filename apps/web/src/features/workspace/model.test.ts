import { describe, it, expect } from 'vitest';
import { annotationsOptions, redactOptions } from '@pdftools/shared';
import { buildPayload, move, normRect, resizeTo, simplify, type A, type R } from './model';

const rect = (o: Partial<A> = {}): A => ({ id: 'a', type: 'rect', page: 0, x: 0.2, y: 0.2, w: 0.3, h: 0.2, stroke: '#000000', fill: null, strokeWidth: 1, opacity: 1, ...o } as A);

describe('workspace model', () => {
  it('moves items and keeps them on the page', () => {
    expect(move(rect(), 0.1, 0.1)).toMatchObject({ x: expect.closeTo(0.3), y: expect.closeTo(0.3) });
    expect(move(rect(), 5, 5)).toMatchObject({ x: expect.closeTo(0.7), y: expect.closeTo(0.8) });
    expect(move(rect(), -5, -5)).toMatchObject({ x: 0, y: 0 });
  });
  it('moves lines and freehand strokes as a unit', () => {
    const line = { id: 'l', type: 'line', page: 0, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.2, color: '#000000', strokeWidth: 1, opacity: 1 } as A;
    const m = move(line, 0.5, 0) as unknown as { x1: number; x2: number };
    expect(m.x2).toBeCloseTo(1); expect(m.x1).toBeCloseTo(0.2); // clamped by the right-most point
    const draw = { id: 'd', type: 'draw', page: 0, points: [[0.1, 0.1], [0.2, 0.3]], color: '#000000', strokeWidth: 1, opacity: 1 } as A;
    expect((move(draw, 0.1, 0.1) as unknown as { points: number[][] }).points).toEqual([[0.2, 0.2], [0.3, 0.4]].map(([a, b]) => [expect.closeTo(a!), expect.closeTo(b!)]));
  });
  it('resizes from the bottom-right corner within the page and with a minimum size', () => {
    expect(resizeTo(rect(), 0.9, 0.9)).toMatchObject({ w: expect.closeTo(0.7), h: expect.closeTo(0.7) });
    expect(resizeTo(rect(), 5, 5)).toMatchObject({ w: expect.closeTo(0.8), h: expect.closeTo(0.8) });
    expect(resizeTo(rect(), 0, 0)).toMatchObject({ w: 0.01, h: 0.01 });
  });
  it('normalises drag rectangles regardless of direction', () => {
    expect(normRect([0.5, 0.5], [0.2, 0.1])).toMatchObject({ x: 0.2, y: 0.1, w: expect.closeTo(0.3), h: expect.closeTo(0.4) });
  });
  it('simplifies strokes but always keeps endpoints', () => {
    const pts: [number, number][] = Array.from({ length: 1000 }, (_, i) => [0.1 + i * 0.00001, 0.5]);
    const s = simplify(pts);
    expect(s.length).toBeLessThan(20);
    expect(s[s.length - 1]).toEqual(pts[999]);
    expect(simplify([[0.5, 0.5]]).length).toBe(2); // a single tap still yields a valid 2-point stroke
  });
  it('builds API payloads that satisfy the shared schemas', () => {
    const img = new File(['x'], 'sig.png');
    const other = new File(['y'], 'unused.png');
    const items: A[] = [rect(), { id: 'i', type: 'image', page: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1, imageIndex: 1, opacity: 1 } as A];
    const p = buildPayload('edit', items, [other, img], 150);
    expect(p.images).toEqual([img]); // only the used image is uploaded
    expect((p.options.annotations as A[])[1]).toMatchObject({ imageIndex: 0 });
    expect(annotationsOptions.safeParse(p.options).success).toBe(true);
    const reds: R[] = [{ id: 'r', page: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }];
    const rp = buildPayload('redact', reds, [], 200);
    expect(redactOptions.safeParse(rp.options).success).toBe(true);
    expect(JSON.stringify(rp.options)).not.toContain('"id"');
  });
});
