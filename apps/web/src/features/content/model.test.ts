import { describe, it, expect } from 'vitest';
import { editContentOptions } from '@pdftools/shared';
import { buildContentPayload, imageBox, textBox, type Matrix } from './model';

// pdf.js scale-1 viewport for an unrotated 400x200 page: flip y.
const VP: Matrix = [1, 0, 0, -1, 0, 200];

describe('box geometry', () => {
  it('horizontal text: box sits on the baseline with ascent above and descent below', () => {
    // 20pt text starting at user (30,150): baseline is 50 from the top, 80pt wide
    const b = textBox(VP, 400, 200, [20, 0, 0, 20, 30, 150], 80);
    expect(b.x).toBeCloseTo(30 / 400, 5); expect(b.w).toBeCloseTo(80 / 400, 5);
    expect(b.y).toBeCloseTo((50 - 16) / 200, 5);   // 0.8em above the baseline
    expect(b.h).toBeCloseTo(20 / 200, 5);          // 0.8em + 0.2em
  });
  it('page rotated 90 degrees: the box follows the rotated text', () => {
    // viewport for a 400x200 page displayed rotated 90deg clockwise (display 200x400)
    const vp90: Matrix = [0, 1, 1, 0, 0, 0];
    const b = textBox(vp90, 200, 400, [20, 0, 0, 20, 30, 150], 80);
    // text runs downward on screen: x ~ baseline column (150), y from 30 to 110
    expect(b.y).toBeCloseTo(30 / 400, 5); expect(b.h).toBeCloseTo(80 / 400, 5);
    expect(b.x * 200).toBeGreaterThan(130); expect(b.x * 200 + b.w * 200).toBeLessThan(175);
  });
  it('image box from its cm matrix', () => {
    const b = imageBox(VP, 400, 200, [200, 0, 0, 100, 50, 80]); // 200x100 at user (50,80)
    expect(b).toMatchObject({ x: 50 / 400 }); expect(b.w).toBeCloseTo(0.5, 5);
    expect(b.y).toBeCloseTo((200 - 180) / 200, 5); expect(b.h).toBeCloseTo(0.5, 5);
  });
});

describe('payload', () => {
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  const base = { page: 0, box, original: 'Alice', replacement: 'Bob', font: 'auto' as const, bold: null, italic: null, size: null, color: null };
  it('only sends style overrides the user actually set, and validates against the API schema', () => {
    const b = buildContentPayload([base, { ...base, replacement: '', bold: true, size: 14, color: '#ff0000' }], []);
    expect(b.count).toBe(2);
    expect(b.options.textEdits[0]).not.toHaveProperty('bold');
    expect(b.options.textEdits[1]).toMatchObject({ bold: true, size: 14, color: '#ff0000', replacement: '' });
    expect(editContentOptions.safeParse(b.options).success).toBe(true);
  });
  it('re-indexes replacement images, shares one upload between edits, and skips replace edits with no file', () => {
    const f1 = new File(['a'], 'a.png'), f2 = new File(['b'], 'b.png');
    const mk = (action: 'delete' | 'replace', file?: File) => ({ page: 0, box, action, file, fit: 'contain' as const });
    const b = buildContentPayload([], [mk('replace', f2), mk('replace', f1), mk('replace', f2), mk('delete'), mk('replace')]);
    expect(b.images).toEqual([f2, f1]);
    expect(b.options.imageEdits.map((e) => ('imageIndex' in e ? e.imageIndex : 'none'))).toEqual([0, 1, 0, 'none']);
    expect(b.count).toBe(4);
    expect(editContentOptions.safeParse(b.options).success).toBe(true);
  });
  it('nothing to do yields count 0 (the page then refuses to submit)', () => {
    expect(buildContentPayload([], []).count).toBe(0);
  });
});
