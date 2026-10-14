import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runEngine } from './helpers.js';
import type { ProcessContext } from './types.js';

export interface Word { text: string; x0: number; y0: number; x1: number; y1: number }
export interface PageWords { width: number; height: number; words: Word[] }
/** Rectangle as fractions (0..1) of the displayed page, origin top-left: the same space the redactor burns in. */
export interface Hit { page: number; x: number; y: number; w: number; h: number }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const c = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

/** Parse `pdftotext -bbox` output (word boxes in points, origin top-left of the displayed page). */
export function parseBBox(xml: string): PageWords[] {
  const pages: PageWords[] = [];
  const re = /<page width="([\d.]+)" height="([\d.]+)">|<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1]) pages.push({ width: Number(m[1]), height: Number(m[2]), words: [] });
    else pages[pages.length - 1]?.words.push({ text: unescapeXml(m[7]!), x0: Number(m[3]), y0: Number(m[4]), x1: Number(m[5]), y1: Number(m[6]) });
  }
  return pages;
}

export async function extractWords(ctx: ProcessContext, pdf: string): Promise<PageWords[]> {
  const out = join(ctx.workDir, 'words.html');
  await runEngine(ctx, 'pdftotext', ['-bbox', '-enc', 'UTF-8', pdf, out]);
  return parseBBox(await readFile(out, 'utf8'));
}

const fold = (s: string, cs: boolean) => (cs ? s : s.toLowerCase());

/**
 * Find every occurrence of each term in the page text. Words are joined with single spaces (so a phrase can
 * span a line break). Any word that overlaps a match is covered in full, so a term inside a longer word
 * ("ann" in "Hannah") redacts the whole word: over-covering is the safe failure for redaction.
 * Words on one line that belong to the same match are merged into a single box.
 */
export function findHits(pages: PageWords[], terms: string[], caseSensitive: boolean): { hits: Hit[]; perTerm: Map<string, number> } {
  const hits: Hit[] = [];
  const perTerm = new Map<string, number>(terms.map((t) => [t, 0]));
  pages.forEach((pg, pageIdx) => {
    if (!pg.words.length || !pg.width || !pg.height) return;
    let text = '';
    const owner: number[] = []; // char index -> word index
    pg.words.forEach((w, wi) => {
      if (text) { text += ' '; owner.push(-1); }
      const t = fold(w.text, caseSensitive);
      for (let k = 0; k < t.length; k++) owner.push(wi);
      text += t;
    });
    const covered = new Set<string>(); // "start-end" word ranges already boxed on this page
    for (const term of terms) {
      const needle = fold(term.trim().replace(/\s+/g, ' '), caseSensitive);
      if (!needle) continue;
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const idx = new Set<number>();
        for (let i = at; i < at + needle.length; i++) if (owner[i]! >= 0) idx.add(owner[i]!);
        const list = [...idx].sort((a, b) => a - b);
        if (!list.length) continue;
        perTerm.set(term, (perTerm.get(term) ?? 0) + 1);
        // group into runs on the same line
        let run: Word[] = [];
        const flush = () => {
          if (!run.length) return;
          const x0 = Math.min(...run.map((w) => w.x0)), x1 = Math.max(...run.map((w) => w.x1));
          const y0 = Math.min(...run.map((w) => w.y0)), y1 = Math.max(...run.map((w) => w.y1));
          const key = `${pageIdx}:${x0.toFixed(2)}:${y0.toFixed(2)}:${x1.toFixed(2)}:${y1.toFixed(2)}`;
          if (!covered.has(key)) {
            covered.add(key);
            const pad = 1; // points; covers glyph overhang
            const cx0 = Math.max(0, x0 - pad), cy0 = Math.max(0, y0 - pad), cx1 = Math.min(pg.width, x1 + pad), cy1 = Math.min(pg.height, y1 + pad);
            hits.push({ page: pageIdx, x: cx0 / pg.width, y: cy0 / pg.height, w: (cx1 - cx0) / pg.width, h: (cy1 - cy0) / pg.height });
          }
          run = [];
        };
        for (const wi of list) {
          const w = pg.words[wi]!;
          const last = run[run.length - 1];
          if (last && Math.abs(w.y0 - last.y0) > (last.y1 - last.y0) / 2) flush();
          run.push(w);
        }
        flush();
      }
    }
  });
  return { hits, perTerm };
}
