import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import type { ToolId } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { loadPdfFile } from './pdf.js';
import { runEngine, baseName, one, parseOptions, type Processor } from './helpers.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Text-layer check: converting a scan produces pictures, not editable text, and the user should be told. */
async function textPerPage(ctx: Parameters<Processor>[0], pdf: string, pageCount: number): Promise<string[]> {
  const out = join(ctx.workDir, 'layout.txt');
  await runEngine(ctx, 'pdftotext', ['-layout', '-enc', 'UTF-8', pdf, out]);
  const pages = (await readFile(out, 'utf8')).split('\f');
  while (pages.length > pageCount) pages.pop();
  while (pages.length < pageCount) pages.push('');
  return pages;
}

const NO_TEXT = 'No text layer was found. This looks like a scanned PDF, so the result contains pictures rather than editable text. OCR is not available yet.';

/** LibreOffice imports the PDF into Draw/Writer/Impress and exports the target format. */
async function viaLibreOffice(ctx: Parameters<Processor>[0], pdf: string, infilter: string, ext: 'docx' | 'pptx'): Promise<string> {
  const src = join(ctx.workDir, 'input.pdf');
  if (pdf !== src) await writeFile(src, await readFile(pdf));
  const outDir = join(ctx.workDir, 'lo-out');
  await mkdir(outDir);
  await runEngine(ctx, 'soffice', [
    `-env:UserInstallation=file://${join(ctx.workDir, 'lo-profile')}`,
    '--headless', '--norestore', '--nologo', '--nofirststartwizard',
    `--infilter=${infilter}`, '--convert-to', ext, '--outdir', outDir, src,
  ], { office: true });
  const out = join(outDir, `input.${ext}`);
  try { if ((await stat(out)).size === 0) throw new Error('empty'); }
  catch { throw new ToolError('engine_failed', 'The PDF could not be converted. It may be damaged or too complex.'); }
  return out;
}

function officeProcessor(tool: ToolId, infilter: string, ext: 'docx' | 'pptx', mime: string, note: string): Processor {
  return async (ctx) => {
    parseOptions(tool, ctx.options);
    const f = one(ctx);
    const doc = await loadPdfFile(f.path, ctx.maxPages);
    const text = await textPerPage(ctx, f.path, doc.getPageCount());
    const out = await viaLibreOffice(ctx, f.path, infilter, ext);
    const warnings = [note];
    if (text.every((t) => t.trim() === '')) warnings.unshift(NO_TEXT);
    return { path: out, name: `${baseName(f.name)}.${ext}`, mime, warnings, stats: { pages: doc.getPageCount() } };
  };
}

const pdfToWord = officeProcessor('pdf-to-word', 'writer_pdf_import', 'docx', DOCX,
  'Text is placed to match the PDF layout, so it is editable but often sits in positioned frames rather than flowing paragraphs. Complex layouts, fonts and tables will not match exactly.');
const pdfToPowerpoint = officeProcessor('pdf-to-powerpoint', 'impress_pdf_import', 'pptx', PPTX,
  'Each PDF page becomes one slide with its text and graphics as separate objects. Complex layouts and fonts may differ from the original.');

// ------------------------------------------------------------ PDF -> Excel
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(i: number): string {
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const NUMBER = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** Plain numbers become numeric cells; everything else stays text so nothing is silently reinterpreted (IDs, phone numbers, dates). */
export function parseCell(raw: string): { n: number } | { s: string } {
  const t = raw.trim();
  if (NUMBER.test(t) && !/^[-+]?0\d/.test(t) && t.replace(/[^\d]/g, '').length <= 15) return { n: Number(t.replace(/,/g, '')) };
  return { s: t };
}

/** Split a pdftotext -layout page into rows of cells. A run of 2+ spaces (or a tab) separates columns. */
export function rowsOf(pageText: string): string[][] {
  const rows = pageText.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '').map((l) => l.trim().split(/ {2,}|\t+/));
  return rows;
}

export const MAX_COLS = 200;

export function sheetXml(rows: string[][]): string {
  const body = rows.map((cells, r) => {
    const cs = cells.slice(0, MAX_COLS).map((c, i) => {
      const v = parseCell(c), ref = `${colName(i)}${r + 1}`;
      return 'n' in v ? `<c r="${ref}"><v>${v.n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v.s)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: { name: string; rows: string[][] }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows)); });
  return zipSync(files, { level: 6 });
}

const pdfToExcel: Processor = async (ctx) => {
  parseOptions('pdf-to-excel', ctx.options);
  const f = one(ctx);
  const doc = await loadPdfFile(f.path, ctx.maxPages);
  const text = await textPerPage(ctx, f.path, doc.getPageCount());
  if (text.every((t) => t.trim() === '')) throw new ToolError('no_text', 'No text layer was found. This looks like a scanned PDF, and OCR is not available yet, so there is nothing to put in a spreadsheet.');
  // Pages with no text still get a sheet so sheet numbers match page numbers.
  const sheets = text.map((t, i) => ({ name: `Page ${i + 1}`, rows: rowsOf(t) }));
  const path = join(ctx.workDir, 'result.xlsx');
  await writeFile(path, buildXlsx(sheets));
  const cells = sheets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.length, 0), 0);
  return {
    path, name: `${baseName(f.name)}.xlsx`, mime: XLSX, stats: { pages: sheets.length, cells },
    warnings: ['Columns are detected from gaps in the text, one sheet per page. This works for text-based tables; merged cells, ruled tables without clear gaps and multi-line cells may be split wrongly. Check the numbers before using them.'],
  };
};

export const CONVERT: Partial<Record<ToolId, Processor>> = {
  'pdf-to-word': pdfToWord, 'pdf-to-powerpoint': pdfToPowerpoint, 'pdf-to-excel': pdfToExcel,
};
