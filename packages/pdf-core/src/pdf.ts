import { readFile } from 'node:fs/promises';
import { PDFDocument } from '@cantoo/pdf-lib';
import { ToolError } from './errors.js';

export interface PdfInfo {
  pages: number;
}

/** Structural validation: parses the document and rejects encrypted/damaged files. */
export async function inspectPdf(path: string): Promise<PdfInfo> {
  const bytes = await readFile(path);
  return (await loadPdf(bytes)).info;
}

export async function loadPdf(bytes: Uint8Array, opts: { preserveXFA?: boolean } = {}): Promise<{ doc: PDFDocument; info: PdfInfo }> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, ...opts });
    return { doc, info: { pages: doc.getPageCount() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/encrypt/i.test(msg)) {
      throw new ToolError('encrypted_pdf', 'This PDF is password-protected. Unlock it first.');
    }
    throw new ToolError('invalid_pdf', 'This file is not a valid or readable PDF.');
  }
}

export async function loadPdfFile(path: string, maxPages: number, opts: { preserveXFA?: boolean } = {}): Promise<PDFDocument> {
  const { doc, info } = await loadPdf(await readFile(path), opts);
  if (info.pages === 0) throw new ToolError('invalid_pdf', 'This PDF has no pages.');
  if (info.pages > maxPages) throw new ToolError('too_many_pages', `PDF has ${info.pages} pages; the limit is ${maxPages}.`);
  return doc;
}
