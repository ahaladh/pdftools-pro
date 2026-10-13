import { describe, it, expect } from 'vitest';
import { safeNext } from './safeNext';

describe('safeNext', () => {
  it('keeps same-site paths', () => {
    expect(safeNext('/admin')).toBe('/admin');
    expect(safeNext('/pricing?x=1#top')).toBe('/pricing?x=1#top');
  });
  it('rejects anything that could leave the origin', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'http://evil.com/a', 'javascript:alert(1)', 'evil.com', '/\t//evil.com', '/\n//evil.com', '']) {
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/account');
    }
    expect(safeNext(null)).toBe('/account');
    expect(safeNext(undefined, '/x')).toBe('/x');
  });
});
