import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PDFDocument } from '@cantoo/pdf-lib';
import { zipSync } from 'fflate';
import { optionSchemas, parsePageRanges, type ToolId, type ToolOptions } from '@pdftools/shared';
import { ToolError } from './errors.js';
import { run, runCapture } from './exec.js';
import type { ProcessContext, ProcessResult } from './types.js';

export const PDF_MIME = 'application/pdf';
export const baseName = (n: string) => n.replace(/\.[^.]+$/, '') || 'document';

export async function savePdf(ctx: ProcessContext, doc: PDFDocument, name: string, warnings: string[] = [], stats?: ProcessResult['stats']): Promise<ProcessResult> {
  const path = join(ctx.workDir, 'result.pdf');
  await writeFile(path, await doc.save());
  return { path, name, mime: PDF_MIME, warnings, stats };
}

export function one(ctx: ProcessContext) {
  const f = ctx.inputs[0];
  if (!f) throw new ToolError('no_input', 'No input file');
  return f;
}

export function parseOptions<T extends ToolId>(tool: T, raw: unknown): ToolOptions<T> {
  const r = optionSchemas[tool].safeParse(raw ?? {});
  if (!r.success) throw new ToolError('invalid_options', r.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; '));
  return r.data as ToolOptions<T>;
}

export function pages(spec: string, count: number): number[] {
  try { return parsePageRanges(spec, count); } catch (e) { throw new ToolError('invalid_options', (e as Error).message); }
}

export async function zipResult(ctx: ProcessContext, entries: { name: string; data: Uint8Array }[], zipName: string, level: 0 | 6): Promise<ProcessResult> {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) files[e.name] = e.data;
  const path = join(ctx.workDir, 'result.zip');
  await writeFile(path, zipSync(files, { level }));
  return { path, name: zipName, mime: 'application/zip', warnings: [] };
}

export type Processor = (ctx: ProcessContext) => Promise<ProcessResult>;


/** Run an engine for this job with its timeout, cancellation and resource limits applied. */
export function runEngine(ctx: ProcessContext, bin: string, args: string[], opts: { office?: boolean } = {}) {
  const l = ctx.limits;
  // The timeout is a deadline for the WHOLE job, so many small engine calls cannot add up to hours.
  const remaining = (ctx.deadline ?? Date.now() + ctx.timeoutMs) - Date.now();
  if (remaining <= 0) return Promise.reject(new ToolError('timeout', 'Processing took too long and was stopped'));
  return run(bin, args, {
    cwd: ctx.workDir, timeoutMs: remaining, signal: ctx.signal,
    limits: l ? { memoryMB: opts.office ? l.officeMemoryMB ?? l.memoryMB : l.memoryMB, cpuSeconds: l.cpuSeconds, fileMB: l.fileMB } : undefined,
  });
}

/** `runEngine` that also returns stdout. */
export function runEngineOut(ctx: ProcessContext, bin: string, args: string[], opts: { office?: boolean; env?: Record<string, string> } = {}) {
  const l = ctx.limits;
  const remaining = (ctx.deadline ?? Date.now() + ctx.timeoutMs) - Date.now();
  if (remaining <= 0) return Promise.reject(new ToolError('timeout', 'Processing took too long and was stopped'));
  return runCapture(bin, args, {
    cwd: ctx.workDir, timeoutMs: remaining, signal: ctx.signal, env: opts.env,
    limits: l ? { memoryMB: opts.office ? l.officeMemoryMB ?? l.memoryMB : l.memoryMB, cpuSeconds: l.cpuSeconds, fileMB: l.fileMB } : undefined,
  });
}

export const MAX_IMAGE_PIXELS = 100_000_000;

/** Read pixel dimensions from the header only (no decoding). Returns null if unreadable. */
export function imageDimensions(b: Uint8Array, kind: 'jpg' | 'png'): { w: number; h: number } | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (kind === 'png') return buf.length >= 24 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/** Reject decompression-bomb images before any decoder allocates memory for them. */
export function assertImageSize(bytes: Uint8Array, kind: 'jpg' | 'png', name: string) {
  const d = imageDimensions(bytes, kind);
  if (d && d.w * d.h > MAX_IMAGE_PIXELS) throw new ToolError('image_too_large', `"${name}" has too many pixels (${d.w}×${d.h}). The limit is ${MAX_IMAGE_PIXELS / 1_000_000} megapixels.`);
}

/** Map a decoder failure to the right user-facing error: out-of-memory is a limit, not a bad file. */
export function decodeFailure(e: unknown, name: string, kind: string): ToolError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/allocation failed|invalid array length|out of memory|ENOMEM/i.test(msg)) { // not every RangeError: "offset out of bounds" means a corrupt file
    return new ToolError('resource_limit', `"${name}" needs more memory than is allowed to process.`);
  }
  return new ToolError('invalid_image', `"${name}" could not be read as a valid ${kind.toUpperCase()} image.`);
}
