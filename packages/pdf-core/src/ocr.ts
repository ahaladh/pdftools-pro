import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFNumber, PDFOperator, TextRenderingMode, beginText, endText, popGraphicsState, pushGraphicsState, setFontAndSize, setTextMatrix, setTextRenderingMode, showText, StandardFonts } from '@cantoo/pdf-lib';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import { runEngine, runEngineOut, baseName, one, parseOptions, savePdf, type Processor } from './helpers.js';
import { textPerPage } from './convert.js';
import { pageMapper } from './tools3.js';

export interface OcrWord { text: string; left: number; top: number; width: number; height: number; conf: number }

/** Parse Tesseract TSV output into word boxes (pixels). */
export function parseTsv(tsv: string): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const [left, top, width, height, conf] = [c[6], c[7], c[8], c[9], c[10]].map(Number) as [number, number, number, number, number];
    if (!text || ![left, top, width, height, conf].every(Number.isFinite) || width <= 0 || height <= 0 || conf < 0) continue;
    words.push({ text, left, top, width, height, conf });
  }
  return words;
}

const MAX_PIXELS_PAGE = 100_000_000;
const LOW_CONFIDENCE = 60;

const ocr: Processor = async (ctx) => {
  const o = parseOptions('ocr', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const n = doc.getPageCount();

  const listing = await runEngineOut(ctx, 'tesseract', ['--list-langs']);
  const installed = new Set(listing.split('\n').map((l) => l.trim()).filter((l) => l && !/^List of/i.test(l)));
  const missing = o.language.split('+').filter((l) => !installed.has(l));
  if (missing.length) throw new ToolError('language_unavailable', `OCR language "${missing.join('", "')}" is not installed on this server. Available: ${[...installed].filter((l) => l !== 'osd').sort().join(', ') || 'none'}.`);

  const hasText = o.skipTextPages ? (await textPerPage(ctx, f.path, n)).map((t) => t.trim() !== '') : new Array<boolean>(n).fill(false);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const allowed = new Set(font.getCharacterSet());
  let substituted = 0;
  const clean = (s: string) => {
    let out = '';
    for (const ch of s.normalize('NFC')) {
      if (allowed.has(ch.codePointAt(0)!)) { out += ch; continue; }
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      if (base && [...base].every((b) => allowed.has(b.codePointAt(0)!))) out += base;
      else { out += '?'; substituted++; }
    }
    return out;
  };

  let pagesOcr = 0, words = 0, confSum = 0;
  const targets = hasText.map((t, i) => (t ? -1 : i)).filter((i) => i >= 0);
  for (const [k, i] of targets.entries()) {
    const page = doc.getPage(i);
    const { width: pw, height: ph } = page.getSize();
    if ((pw / 72) * o.dpi * (ph / 72) * o.dpi > MAX_PIXELS_PAGE) throw new ToolError('page_too_large', 'A page is too large to recognise at this resolution. Choose a lower DPI.');
    const stem = join(ctx.workDir, `ocr-${i + 1}`);
    await runEngine(ctx, 'pdftoppm', ['-r', String(o.dpi), '-f', String(i + 1), '-l', String(i + 1), '-gray', '-png', '-singlefile', f.path, stem]);
    const head = await readFile(`${stem}.png`);
    const W = head.readUInt32BE(16), H = head.readUInt32BE(20);
    await runEngine(ctx, 'tesseract', [`${stem}.png`, stem, '-l', o.language, '--dpi', String(o.dpi), '--psm', '3', 'tsv']);
    const found = parseTsv(await readFile(`${stem}.tsv`, 'utf8'));

    const { rot, vw, vh, pt } = pageMapper(page);
    page.setFont(font);
    const fontKey = (page as unknown as { fontKey: string }).fontKey;
    const ops = [pushGraphicsState()];
    const rad = (rot * Math.PI) / 180, cos = Math.round(Math.cos(rad)), sin = Math.round(Math.sin(rad));
    for (const w of found) {
      const text = clean(w.text);
      if (!text.trim()) continue;
      const u = w.left / W, v = w.top / H, wf = w.width / W, hf = w.height / H;
      const size = Math.min(200, Math.max(1, hf * vh * 0.9));
      const natural = font.widthOfTextAtSize(text, size);
      const tz = natural > 0 ? Math.min(400, Math.max(20, ((wf * vw) / natural) * 100)) : 100;
      const o0 = pt(u, v + hf * 0.82); // baseline sits near the bottom of the word box
      ops.push(
        beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(fontKey, size),
        PDFOperator.of('Tz' as never, [PDFNumber.of(tz)]),
        setTextMatrix(cos, sin, -sin, cos, o0.x, o0.y), showText(font.encodeText(text)), endText(),
      );
      words++; confSum += w.conf;
    }
    ops.push(popGraphicsState());
    if (ops.length > 2) page.pushOperators(...ops);
    pagesOcr++;
    ctx.onProgress?.(Math.round(((k + 1) / targets.length) * 90));
  }

  const warnings: string[] = [];
  const mean = words ? confSum / words : 0;
  if (!targets.length) warnings.push('Every page already has a text layer, so nothing was recognised. Turn off "skip pages that already have text" to recognise them anyway.');
  else if (!words) warnings.push('No text was recognised. The pages may be blank, too low in resolution, or in a language other than the one chosen.');
  else if (mean < LOW_CONFIDENCE) warnings.push(`Recognition confidence is low (${Math.round(mean)}%). The scan may be blurry, skewed or low resolution, so the text layer is probably unreliable. Try a clearer scan or a higher DPI.`);
  if (substituted) warnings.push(`${substituted} character${substituted === 1 ? '' : 's'} outside the Latin alphabet could not be stored and ${substituted === 1 ? 'was' : 'were'} replaced with "?". Non-Latin languages are not fully supported.`);
  if (hasText.some(Boolean) && targets.length) warnings.push(`${n - targets.length} page${n - targets.length === 1 ? ' already had' : 's already had'} text and ${n - targets.length === 1 ? 'was' : 'were'} left unchanged.`);
  if (words) warnings.push('The recognised text is stored invisibly under the original scan. Recognition can contain mistakes; check anything important.');
  return savePdf(ctx, doc, `${baseName(f.name)}-ocr.pdf`, warnings, { pagesRecognised: pagesOcr, pagesSkipped: n - pagesOcr, words, ...(words ? { meanConfidence: Math.round(mean) } : {}) });
};

export const OCR_TOOLS = { ocr };
