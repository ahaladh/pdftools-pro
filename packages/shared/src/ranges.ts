/**
 * Parse a human page-range string ("1-3, 5, 8-") into sorted unique 0-based
 * indices. Throws on invalid syntax or out-of-range pages.
 * "all" or an empty string selects every page.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const text = input.trim().toLowerCase();
  if (text === '' || text === 'all') return Array.from({ length: pageCount }, (_, i) => i);
  const out = new Set<number>();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!part || !m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${part}"`);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : pageCount) : start;
    if (start < 1 || end < start || end > pageCount) {
      throw new Error(`Page range "${part}" is outside 1-${pageCount}`);
    }
    for (let p = start; p <= end; p++) out.add(p - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Like parsePageRanges but preserves order and duplicates ("3,1,1,2"). */
export function parsePageSequence(input: string, pageCount: number): number[] {
  const out: number[] = [];
  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1 || n > pageCount) throw new Error(`Page ${n} is outside 1-${pageCount}`);
      out.push(n - 1);
    } else {
      out.push(...parsePageRanges(part, pageCount));
    }
  }
  if (out.length === 0) throw new Error('Page order is empty');
  return out;
}
