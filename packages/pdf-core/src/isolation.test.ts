import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from '@cantoo/pdf-lib';
// Import the BUILT package: worker threads need the compiled thread.js (npm test builds first).
import { processToolIsolated, isolationAvailable } from '../dist/index.js';

let dir: string; let n = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'iso-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function pdf(pages: number, name: string) {
  const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([300, 400]);
  const path = join(dir, `${name}.pdf`); await writeFile(path, await d.save());
  return { path, name: `${name}.pdf`, kind: 'pdf' as const };
}
const ctx = async (inputs: { path: string; name: string; kind: 'pdf' | 'png' | 'jpg' }[], options: unknown = {}, extra = {}) => {
  const workDir = join(dir, `w${n++}`); await mkdir(workDir);
  return { workDir, inputs, options, timeoutMs: 60_000, maxPages: 5000, ...extra };
};

/** A valid PNG whose pixel data is tiny on disk but huge when decoded. */
function pngBomb(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA: pdf-lib must fully decode to split the alpha channel (opaque RGB is passed through undecoded)
  const raw = Buffer.alloc(h * (1 + w * 4)); // filter byte + RGBA zeros per row
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

describe('process isolation (kernel-limited job process)', () => {
  it('is available against the built package', () => expect(isolationAvailable()).toBe(true));

  it('runs a tool in an isolated process and relays progress and results', async () => {
    const progress: number[] = [];
    const r = await processToolIsolated('merge', { ...(await ctx([await pdf(2, 'a'), await pdf(3, 'b')])), onProgress: (p) => progress.push(p) });
    expect(r.name).toBe('merged.pdf');
    expect(progress.length).toBeGreaterThan(0);
    expect((await PDFDocument.load(await (await import('node:fs/promises')).readFile(r.path))).getPageCount()).toBe(5);
  });

  it('preserves ToolError codes across the process boundary', async () => {
    await expect(processToolIsolated('merge', await ctx([await pdf(1, 'solo')]))).rejects.toMatchObject({ name: 'ToolError', code: 'invalid_input' });
  });

  it('contains a decompression bomb: the job process is stopped by the kernel, this process survives and keeps working', async () => {
    const path = join(dir, 'bomb.png'); await writeFile(path, pngBomb(12000, 8000)); // 96 MP (under the pixel guard), ~384 MB decoded RGBA
    const run = async (memoryMB: number) => processToolIsolated('images-to-pdf', await ctx([{ path, name: 'bomb.png', kind: 'png' }]), { memoryMB });
    // control: with a generous cap the very same file converts, so the failure below is the limit's doing
    await expect(run(8192)).resolves.toMatchObject({ name: 'images.pdf' });
    const before = process.memoryUsage().rss;
    await expect(run(1536)).rejects.toMatchObject({ code: 'resource_limit' });
    expect(process.memoryUsage().rss - before).toBeLessThan(300 * 1024 * 1024); // the host never held the decoded image
    expect((await processToolIsolated('rotate', await ctx([await pdf(1, 'after')], { angle: 90 }))).name).toBe('after-rotated.pdf');
  }, 180_000);

  it('rejects absurd image dimensions before decoding anything', async () => {
    const path = join(dir, 'huge.png'); await writeFile(path, pngBomb(20000, 20000).subarray(0, 60)); // header only is enough for the guard
    await expect(processToolIsolated('images-to-pdf', await ctx([{ path, name: 'huge.png', kind: 'png' }]))).rejects.toMatchObject({ code: 'image_too_large' });
  });

  it('keeps the host event loop responsive while a heavy job runs', async () => {
    const big = await pdf(1500, 'big');
    let worst = 0, last = Date.now();
    const t = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 20); last = now; }, 20);
    const t0 = Date.now();
    await processToolIsolated('extract-pages', await ctx([big], { pages: 'all' }));
    const took = Date.now() - t0;
    clearInterval(t);
    expect(took).toBeGreaterThan(100); // genuinely busy
    expect(worst).toBeLessThan(150); // main thread was never blocked for long
  }, 120_000);

  it('cancellation stops the job promptly and kills the child engine', async () => {
    const big = await pdf(80, 'many');
    const ac = new AbortController();
    const p = processToolIsolated('pdf-to-images', { ...(await ctx([big], { format: 'png', dpi: 300 })), signal: ac.signal });
    setTimeout(() => ac.abort(), 400);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(Date.now() - t0).toBeLessThan(5000);
    await new Promise((r) => setTimeout(r, 1500));
    // no pdftoppm left behind for this job
    const left = execFileSync('sh', ['-c', `ps -eo cmd | grep -c "[p]dftoppm.*${dir.replace(/[^\w/-]/g, '.')}" || true`]).toString().trim();
    expect(Number(left)).toBe(0);
  }, 60_000);

  it('enforces the wall-clock limit for engine phases', async () => {
    const big = await pdf(60, 'slow');
    const t0 = Date.now();
    await expect(processToolIsolated('pdf-to-images', await ctx([big], { format: 'png', dpi: 300 }, { timeoutMs: 600 }))).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(4000); // the deadline covers the whole job, not each page
  }, 60_000);
});
