import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { limitArgs, run } from './exec.js';
import { processTool } from './processors.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'limits-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const opts = (limits?: Parameters<typeof run>[2]['limits']) => ({ cwd: dir, timeoutMs: 30_000, limits });

describe('engine resource limits (enforced by the kernel via prlimit)', () => {
  it('builds prlimit arguments', () => {
    expect(limitArgs({ memoryMB: 100, cpuSeconds: 2.2, fileMB: 1 })).toEqual([`--as=${100 * 1024 * 1024}`, '--cpu=3', `--fsize=${1024 * 1024}`]);
    expect(limitArgs({})).toEqual([]);
  });

  it('memory: allocating 600 MB succeeds unconfined but is refused under a 150 MB cap', async () => {
    const prog = ['-c', 'x = bytearray(600*1024*1024); x[-1] = 1'];
    await expect(run('python3', prog, opts())).resolves.toBeUndefined(); // control
    await expect(run('python3', prog, opts({ memoryMB: 150 }))).rejects.toMatchObject({ code: 'engine_failed' });
  });

  it('cpu: an infinite loop is killed by the kernel long before the wall-clock timeout', async () => {
    const t0 = Date.now();
    await expect(run('python3', ['-c', 'while True: pass'], { ...opts({ cpuSeconds: 1 }), timeoutMs: 60_000 })).rejects.toMatchObject({ code: 'resource_limit' });
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it('output size: writing 20 MB is refused under a 1 MB file cap but fine without it', async () => {
    const prog = (f: string) => ['-c', `open(${JSON.stringify(f)}, 'wb').write(b'x' * 20 * 1024 * 1024)`];
    const a = join(dir, 'a.bin'), b = join(dir, 'b.bin');
    await run('python3', prog(a), opts());
    expect((await stat(a)).size).toBe(20 * 1024 * 1024);
    await expect(run('python3', prog(b), opts({ fileMB: 1 }))).rejects.toMatchObject({ code: expect.stringMatching(/engine_failed|resource_limit/) });
    expect((await stat(b)).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it('wall clock: a sleeping process is killed at the timeout', async () => {
    await expect(run('python3', ['-c', 'import time; time.sleep(30)'], { ...opts(), timeoutMs: 700 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('real engines still work inside generous limits (Ghostscript, Poppler, LibreOffice)', async () => {
    const limits = { memoryMB: 2048, officeMemoryMB: 4096, cpuSeconds: 60, fileMB: 200 };
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    const pdf = join(dir, 'in.pdf'); await writeFile(pdf, await d.save());
    const ctx = (workDir: string, inputs: { path: string; name: string; kind: 'pdf' | 'office' }[]) => ({ workDir, inputs, options: {}, timeoutMs: 120_000, maxPages: 10, limits });
    const w1 = join(dir, 'w1'); await mkdir(w1);
    expect((await processTool('compress', ctx(w1, [{ path: pdf, name: 'in.pdf', kind: 'pdf' }]))).stats?.originalBytes).toBeGreaterThan(0);
    const w2 = join(dir, 'w2'); await mkdir(w2);
    expect((await processTool('pdf-to-images', { ...ctx(w2, [{ path: pdf, name: 'in.pdf', kind: 'pdf' }]), options: { dpi: 72 } })).mime).toBe('image/jpeg');
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>limits ok</w:t></w:r></w:p></w:body></w:document>'),
    });
    const dp = join(dir, 'm.docx'); await writeFile(dp, docx);
    const w3 = join(dir, 'w3'); await mkdir(w3);
    expect((await processTool('office-to-pdf', ctx(w3, [{ path: dp, name: 'm.docx', kind: 'office' }]))).name).toBe('m.pdf');
  }, 200_000);

  it('real engine under a too-small memory cap fails cleanly instead of hanging or crashing the host', async () => {
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    const pdf = join(dir, 'in2.pdf'); await writeFile(pdf, await d.save());
    const w = join(dir, 'w4'); await mkdir(w);
    await expect(processTool('compress', { workDir: w, inputs: [{ path: pdf, name: 'in2.pdf', kind: 'pdf' }], options: {}, timeoutMs: 30_000, maxPages: 10, limits: { memoryMB: 8 } })).rejects.toMatchObject({ code: expect.stringMatching(/engine_failed|resource_limit/) });
  });
});
