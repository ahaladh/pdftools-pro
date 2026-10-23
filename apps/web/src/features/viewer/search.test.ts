import { describe, it, expect } from 'vitest';
import { buildPageText, findMatches, locate, sameText } from './search';

const pieces = (...s: (string | [string, boolean])[]) => s.map((x) => (typeof x === 'string' ? { str: x } : { str: x[0], hasEOL: x[1] }));

describe('building searchable text', () => {
  it('joins pieces and collapses runs of whitespace to one space', () => {
    expect(buildPageText(pieces('Hello', ' ', 'world', '   ', '  again')).text).toBe('Hello world again');
    expect(buildPageText(pieces('a\tb\n\nc')).text).toBe('a b c');
    expect(buildPageText(pieces('  leading')).text).toBe('leading'); // no space at the very start
  });
  it('puts a space at a line end so a phrase matches across lines, but not inside a word split into pieces', () => {
    expect(buildPageText(pieces(['line one', true], 'line two')).text).toBe('line one line two');
    expect(buildPageText(pieces('Hel', 'lo wor', 'ld')).text).toBe('Hello world'); // kerning/font splits inside a word do not break it
    expect(buildPageText(pieces(['ends with space ', true], 'next')).text).toBe('ends with space next'); // no double space
  });
  it('knows where every character came from', () => {
    const p = buildPageText(pieces('ab', ['cd', true], 'ef'));
    expect(p.text).toBe('abcd ef');
    expect(p.owner.map((o) => o.item)).toEqual([0, 0, 1, 1, -1, 2, 2]);
    expect(p.owner[3]).toEqual({ item: 1, at: 1 });
  });
});

describe('finding matches', () => {
  it('is case-insensitive unless asked, plain text (never a pattern), and never overlaps', () => {
    expect(findMatches('Foo foo FOO', 'foo')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
    expect(findMatches('Foo foo FOO', 'foo', true)).toEqual([{ start: 4, end: 7 }]);
    expect(findMatches('a.b a*b axb', 'a.b')).toEqual([{ start: 0, end: 3 }]);   // the dot is a dot
    expect(findMatches('(x) [y] $5', '(x)')).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches('aaaa', 'aa')).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
  it('matches whitespace loosely and ignores an empty query', () => {
    expect(findMatches('hello world', '  hello    world ')).toEqual([{ start: 0, end: 11 }]);
    expect(findMatches('hello world', '')).toEqual([]);
    expect(findMatches('hello world', '   ')).toEqual([]);
    expect(findMatches('abc', 'abcd')).toEqual([]);
  });
  it('keeps offsets valid for characters whose lower case is longer, and for astral characters', () => {
    const t = 'İstanbul İ';                       // 'İ'.toLowerCase() has two code units
    const m = findMatches(t, 'stanbul');
    expect(t.slice(m[0]!.start, m[0]!.end)).toBe('stanbul');
    const e = 'a😀b 😀B';
    const hits = findMatches(e, '😀b');
    expect(hits.map((h) => e.slice(h.start, h.end))).toEqual(['😀b', '😀B']);
  });
});

describe('mapping a match back onto the pieces', () => {
  it('gives the covered part of each piece, including a phrase that crosses pieces and lines', () => {
    const p = buildPageText(pieces('say hel', ['lo wo', true], 'rld now'));
    expect(p.text).toBe('say hello wo rld now');
    const [m] = findMatches(p.text, 'hello wo rld');
    expect(locate(p, m!)).toEqual([{ item: 0, from: 4, to: 7 }, { item: 1, from: 0, to: 5 }, { item: 2, from: 0, to: 3 }]);
    // the first "o" is the second character of the second piece ("lo wo")
    expect(locate(p, findMatches(p.text, 'o')[0]!)).toEqual([{ item: 1, from: 1, to: 2 }]);
  });
});

describe('trusting the text layer', () => {
  it('only when it describes exactly the same pieces, in the same order', () => {
    const p = pieces('alpha', ' ', 'beta');
    expect(sameText(p, ['alpha', ' ', 'beta'])).toBe(true);
    expect(sameText(p, ['alpha', 'beta'])).toBe(false);               // a piece missing
    expect(sameText(p, ['alpha', ' ', 'beta', ''])).toBe(false);      // a piece added
    expect(sameText(p, ['alpha', 'beta', ' '])).toBe(false);          // same pieces, different order
    expect(sameText(p, ['alpha', ' ', 'Beta'])).toBe(false);          // one character different
    expect(sameText([], [])).toBe(true);
  });
});
