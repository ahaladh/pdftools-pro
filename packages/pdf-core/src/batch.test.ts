import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import { processTool, ToolError, type InputFile } from './index.js';

let root: string;
let n = 0;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'batch-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function pdf(name: string, pages = 1): Promise<InputFile> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]).drawText(`${name} ${i + 1}`, { x: 20, y: 200, size: 18, font });
  const path = join(root, `${n++}-${name}`);
  await writeFile(path, await doc.save());
  return { path, name, kind: 'pdf' };
}
const garbage = async (name: string): Promise<InputFile> => { const path = join(root, `${n++}-garbage`); await writeFile(path, 'this is not a pdf at all'); return { path, name, kind: 'pdf' }; };
async function batch(tool: Parameters<typeof processTool>[0], inputs: InputFile[], options: unknown = {}, extra: Partial<Parameters<typeof processTool>[1]> = {}) {
  const workDir = join(root, `w${n++}`); await mkdir(workDir);
  const res = await processTool(tool, { workDir, inputs, options, timeoutMs: 60_000, maxPages: 100, batch: true, ...extra });
  return { res, workDir, zip: unzipSync(new Uint8Array(await readFile(res.path))) };
}
const rotationOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).getRotation().angle;

describe('batch processing', () => {
  it('applies the tool and its options to every file and returns one archive with a report', async () => {
    const inputs = [await pdf('a.pdf'), await pdf('b.pdf', 2), await pdf('c.pdf')];
    const { res, zip } = await batch('rotate', inputs, { angle: 180, pages: 'all' });
    expect(res).toMatchObject({ mime: 'application/zip', name: 'batch-rotate-3-files.zip', stats: { files: 3, processed: 3, failed: 0 }, warnings: [] });
    const names = Object.keys(zip).filter((k) => k !== 'batch-report.txt');
    expect(names).toHaveLength(3);
    for (const k of names) expect(await rotationOf(zip[k]!)).toBe(180);
    const report = strFromU8(zip['batch-report.txt']!);
    expect(report).toMatch(/Files: 3, processed: 3, failed: 0/);
    for (const i of inputs) expect(report).toContain(`OK  ${i.name} -> `);
  });

  it('keeps names unique when different inputs share one', async () => {
    const { zip } = await batch('rotate', [await pdf('same.pdf'), await pdf('same.pdf'), await pdf('same.pdf')], { angle: 90, pages: 'all' });
    const names = Object.keys(zip).filter((k) => k !== 'batch-report.txt');
    expect(new Set(names).size).toBe(3);
    expect(names.some((x) => /\(2\)/.test(x)) && names.some((x) => /\(3\)/.test(x))).toBe(true);
    // a result named exactly like the report (pdf-to-text on "batch-report.pdf" gives batch-report.txt) cannot overwrite it
    const { zip: z2 } = await batch('pdf-to-text', [await pdf('batch-report.pdf')], {});
    expect(strFromU8(z2['batch-report.txt']!)).toMatch(/^Batch: pdf-to-text/);
    expect(Object.keys(z2).sort()).toEqual(['batch-report (2).txt', 'batch-report.txt']);
    expect(strFromU8(z2['batch-report (2).txt']!)).toContain('batch-report.pdf 1');
  });

  it('a file that fails is reported and the rest carry on', async () => {
    const { res, zip } = await batch('rotate', [await pdf('good1.pdf'), await garbage('broken.pdf'), await pdf('good2.pdf')], { angle: 90, pages: 'all' });
    expect(res.stats).toMatchObject({ files: 3, processed: 2, failed: 1 });
    expect(res.name).toBe('batch-rotate-2-files.zip');
    expect(res.warnings[0]).toMatch(/1 of 3 files could not be processed.*broken\.pdf: This file is not a valid or readable PDF/);
    const report = strFromU8(zip['batch-report.txt']!);
    expect(report).toMatch(/FAILED  broken\.pdf: /); expect(report).toMatch(/OK  good1\.pdf/); expect(report).toMatch(/OK  good2\.pdf/);
    expect(Object.keys(zip).filter((k) => k.endsWith('.pdf'))).toHaveLength(2);
  });

  it('is a failure only when every file fails, and says why', async () => {
    await expect(batch('rotate', [await garbage('x.pdf'), await garbage('y.pdf')], { angle: 90, pages: 'all' })).rejects.toMatchObject({ code: 'batch_failed', message: expect.stringMatching(/None of the 2 files could be processed.*x\.pdf: .*not a valid/) });
  });

  it('applies the page limit to each file separately', async () => {
    const { res } = await batch('rotate', [await pdf('short.pdf', 2), await pdf('long.pdf', 6), await pdf('short2.pdf', 3)], { angle: 90, pages: 'all' }, { maxPages: 4 });
    expect(res.stats).toMatchObject({ processed: 2, failed: 1 });
    expect(res.warnings[0]).toMatch(/long\.pdf: .*limit/i);
  });

  it('refuses tools that are not one-in, one-out (merge, organize, redact…) before touching any file', async () => {
    for (const tool of ['merge', 'organize', 'redact', 'edit-content', 'fill-form', 'compare', 'images-to-pdf'] as const) {
      await expect(batch(tool, [await pdf('a.pdf')]), tool).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(batch('rotate', [], { angle: 90, pages: 'all' })).rejects.toMatchObject({ code: 'no_input' });
  });

  it('stops between files when cancelled: the next file is not even started, so a bad file after the cancel point cannot turn it into a "success"', async () => {
    const ac = new AbortController();
    const inputs = [await pdf('1.pdf'), await garbage('2.pdf'), await garbage('3.pdf')];
    await expect(batch('rotate', inputs, { angle: 90, pages: 'all' }, { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports files it did not reach when the batch deadline passes, instead of overrunning', async () => {
    const inputs = [await pdf('1.pdf'), await pdf('2.pdf')];
    // the batch's own deadline is already behind us: nothing may start
    await expect(batch('rotate', inputs, { angle: 90, pages: 'all' }, { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'batch_failed', message: expect.stringMatching(/not processed, the time limit/) });
    // a deadline that passes part-way: the first file completes, then the clock jumps past it and the rest are reported as not processed
    const three = [await pdf('1.pdf'), await pdf('2.pdf'), await pdf('3.pdf')];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { res, zip } = await batch('rotate', three, { angle: 90, pages: 'all' }, { deadline: Date.now() + 5_000, onProgress: () => vi.setSystemTime(Date.now() + 60_000) });
      expect(res.stats).toMatchObject({ files: 3, processed: 1, failed: 2 });
      expect(res.warnings[0]).toMatch(/2 of 3 files could not be processed.*2\.pdf: not processed, the time limit.*3\.pdf: not processed/);
      const report = strFromU8(zip['batch-report.txt']!);
      expect(report).toMatch(/OK  1\.pdf/); expect(report).toMatch(/NOT PROCESSED  2\.pdf/); expect(report).toMatch(/NOT PROCESSED  3\.pdf/);
    } finally { vi.useRealTimers(); }
  });

  it('leaves no per-file scratch behind and reports progress as it goes', async () => {
    const seen: number[] = [];
    const { workDir } = await batch('rotate', [await pdf('1.pdf'), await pdf('2.pdf'), await pdf('3.pdf'), await pdf('4.pdf')], { angle: 90, pages: 'all' }, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); expect(seen.at(-1)).toBeGreaterThan(90); expect(seen.length).toBe(4);
    expect((await readdir(workDir)).filter((f) => /^b\d+$/.test(f))).toEqual([]); // each file's directory is removed as soon as its result is in the archive
  });

  it('handles a large batch in one go (results are streamed into the archive, not held in memory)', async () => {
    const inputs: InputFile[] = [];
    const one = await pdf('base.pdf');
    for (let i = 0; i < 80; i++) inputs.push({ ...one, name: `doc-${i}.pdf` });
    const before = process.memoryUsage().rss;
    const { res, zip } = await batch('rotate', inputs, { angle: 90, pages: 'all' });
    expect(res.stats).toMatchObject({ files: 80, processed: 80, failed: 0 });
    expect(Object.keys(zip).filter((k) => k.endsWith('.pdf'))).toHaveLength(80);
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024);
  });

  it('does not change single-file behaviour', async () => {
    const workDir = join(root, `w${n++}`); await mkdir(workDir);
    const r = await processTool('rotate', { workDir, inputs: [await pdf('solo.pdf')], options: { angle: 90, pages: 'all' }, timeoutMs: 60_000, maxPages: 100 });
    expect(r.mime).toBe('application/pdf'); expect(r.name).not.toMatch(/\.zip$/);
    void ToolError;
  });
});
