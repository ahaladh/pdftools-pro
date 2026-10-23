/** One piece of page text as pdf.js reports it (only what search needs). */
export interface TextPiece { str: string; hasEOL?: boolean }

export interface PageText {
  /** The page's text with every run of whitespace (and every line end) collapsed to a single space, so a phrase matches across lines. */
  text: string;
  /** For each character of `text`: which piece it came from (-1: a space added between lines) and where in that piece. */
  owner: { item: number; at: number }[];
}

const isSpace = (c: string) => /\s/.test(c);

/** Join a page's text pieces into one searchable string, remembering where every character came from. */
export function buildPageText(pieces: TextPiece[]): PageText {
  let text = '';
  const owner: PageText['owner'] = [];
  const push = (c: string, item: number, at: number) => { text += c; owner.push({ item, at }); };
  pieces.forEach((p, item) => {
    for (let at = 0; at < p.str.length; at++) {
      const c = p.str[at]!;
      if (isSpace(c)) { if (text.length && text[text.length - 1] !== ' ') push(' ', item, at); }
      else push(c, item, at);
    }
    // a line end separates words even when the line has no trailing space
    if (p.hasEOL && text.length && text[text.length - 1] !== ' ') push(' ', -1, 0);
  });
  return { text, owner };
}

export interface Match { start: number; end: number }

/** Lower-case without ever changing the length (some characters lower-case to several), so offsets stay valid. */
/** Surrogate halves must stay paired: iterate UTF-16 units, not code points, so `lower(s).length === s.length`. */
const fold = (s: string) => s.split('').map((c) => { const l = c.toLowerCase(); return l.length === 1 ? l : c; }).join('');

/** Every non-overlapping occurrence of the query (plain text, never a pattern). Whitespace in the query matches any whitespace in the page. */
export function findMatches(page: string, query: string, caseSensitive = false): Match[] {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return [];
  const hay = caseSensitive ? page : fold(page), needle = caseSensitive ? q : fold(q);
  const out: Match[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push({ start: i, end: i + needle.length });
  return out;
}

/** The part of each piece a match covers: [{item, from, to}] with `from`/`to` as offsets into that piece's own string. */
export function locate(page: PageText, m: Match): { item: number; from: number; to: number }[] {
  const parts = new Map<number, { item: number; from: number; to: number }>();
  for (let i = m.start; i < m.end; i++) {
    const o = page.owner[i]!;
    if (o.item < 0) continue;
    const cur = parts.get(o.item);
    if (cur) cur.to = o.at + 1; else parts.set(o.item, { item: o.item, from: o.at, to: o.at + 1 });
  }
  return [...parts.values()];
}

/**
 * Match offsets are only meaningful if the text layer the highlights are measured in and our own reading of the page describe
 * exactly the same pieces in the same order. If they ever differ (a PDF with unusual marked content), highlighting is skipped
 * rather than drawn over the wrong words.
 */
export function sameText(pieces: TextPiece[], layer: string[]): boolean {
  return pieces.length === layer.length && pieces.every((p, i) => p.str === layer[i]);
}

export interface Hit { page: number; start: number; end: number }
export const MAX_HITS = 5000;
