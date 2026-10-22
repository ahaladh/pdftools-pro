import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { ClamdScanner, UploadScanner, parseReply } from './modules/security/antivirus.js';
import { EICAR, FakeClamd } from './testing/fakeclamd.js';

let dir: string; let av: FakeClamd; let unix: FakeClamd;
let n = 0;
const file = async (content: Buffer | string) => { const p = join(dir, `f${n++}`); await writeFile(p, content); return p; };
const scanner = (o: Partial<ConstructorParameters<typeof ClamdScanner>[0]> = {}) => new ClamdScanner({ host: '127.0.0.1', port: av.port, timeoutMs: 3000, ...o });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'av-')); av = await new FakeClamd().start(); unix = await new FakeClamd(join(dir, 'clamd.sock')).start(); });
afterAll(async () => { await av.stop(); await unix.stop(); await rm(dir, { recursive: true, force: true }); });
beforeEach(() => av.reset());

describe('reading clamd\'s answers', () => {
  it('understands clean, infected and error replies, and strips anything odd from signature names', () => {
    expect(parseReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
    expect(parseReply('stream: Evil\x1b[31m.Name\x07 FOUND\n')).toEqual({ status: 'infected', signature: 'Evil[31m.Name' });
    expect(parseReply('INSTREAM size limit exceeded. ERROR\0')).toMatchObject({ status: 'error', reason: 'size_limit' });
    expect(parseReply('')).toMatchObject({ status: 'error', reason: 'protocol' });
    expect(parseReply('stream: OK but not really')).toMatchObject({ status: 'error' }); // only an exact OK is a pass
    expect(parseReply('stream: OK FOUND')).toEqual({ status: 'infected', signature: 'OK' });
    expect((parseReply(`stream: ${'x'.repeat(500)} FOUND`) as { signature: string }).signature).toHaveLength(100);
  });
});

describe('scanning a file', () => {
  it('streams the file to the daemon in length-prefixed chunks, intact and in full, and reports clean', async () => {
    const data = randomBytes(1_000_000);
    const r = await scanner({ chunkBytes: 64 * 1024 }).scan(await file(data));
    expect(r).toEqual({ status: 'clean' });
    expect(av.seen.commands).toEqual(['zINSTREAM']);
    expect(av.seen.streams).toHaveLength(1);
    expect(av.seen.streams[0]).toMatchObject({ bytes: 1_000_000, sha256: sha(data), terminated: true });
    expect(av.seen.streams[0]!.chunks).toBeGreaterThan(10);
  });

  it('reports a file the daemon flags, naming the signature', async () => {
    const r = await scanner().scan(await file(`%PDF-1.4\n% ${EICAR}\n`));
    expect(r).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('can scan an empty file, and over a Unix socket', async () => {
    expect(await scanner().scan(await file(''))).toEqual({ status: 'clean' });
    const r = await new ClamdScanner({ host: 'x', port: 1, socketPath: join(dir, 'clamd.sock'), timeoutMs: 3000 }).scan(await file('%PDF-1.4\nhello'));
    expect(r).toEqual({ status: 'clean' });
    expect(unix.seen.streams).toHaveLength(1);
  });

  it('stops sending when the daemon refuses the size, and says so (it does not hang or send the rest)', async () => {
    av.streamMax = 100_000;
    const t0 = Date.now();
    const r = await scanner({ chunkBytes: 32 * 1024 }).scan(await file(randomBytes(5_000_000)));
    expect(r).toMatchObject({ status: 'error', reason: 'size_limit' });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(av.seen.streams[0]!.bytes).toBeLessThan(2_000_000); // nowhere near the whole file was sent
  });

  it('is an error, never "clean", when the scanner is down, silent, hangs up half-way, or talks nonsense', async () => {
    const f = await file(randomBytes(400_000));
    const dead = await new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
    expect(await scanner({ port: dead }).scan(f)).toMatchObject({ status: 'error', reason: 'unavailable', detail: 'ECONNREFUSED' });
    av.behaviour = 'hang';
    const t0 = Date.now();
    expect(await scanner({ timeoutMs: 300 }).scan(f)).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1500);
    av.behaviour = 'close-early';
    expect(await scanner({ chunkBytes: 16 * 1024 }).scan(f)).toMatchObject({ status: 'error', reason: 'unavailable' });
    av.behaviour = 'garbage';
    expect(await scanner().scan(f)).toMatchObject({ status: 'error', reason: 'protocol', detail: 'what is this' });
    expect(await scanner().scan(join(dir, 'does-not-exist'))).toMatchObject({ status: 'error' });
  });

  it('never lets control characters from the daemon through', async () => {
    av.behaviour = 'weird-signature';
    expect(await scanner().scan(await file('x'))).toEqual({ status: 'infected', signature: 'Evil[31m.Name' });
  });
});

describe('asking whether the daemon is alive', () => {
  it('PING and VERSION', async () => {
    expect(await scanner().ping()).toMatchObject({ ok: true, version: expect.stringContaining('ClamAV 1.4.0') });
    expect(await scanner({ port: 1 }).ping()).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('the upload policy', () => {
  const req = { owner: 'u:abc', ip: '1.2.3.4' } as never;
  const deps = () => ({ log: { warn: vi.fn(), error: vi.fn() }, count: vi.fn(), blocked: vi.fn(async () => undefined) });
  const files = async (...contents: (Buffer | string)[]) => Promise.all(contents.map(async (c, i) => ({ path: await file(c), name: `doc-${i}.pdf` })));
  const gate = (cfg: { mode: 'off' | 'enforce'; failOpen: boolean }, d = deps(), s: ClamdScanner | null = scanner()) => ({ g: new UploadScanner(cfg, s, d), d });

  it('does nothing when switched off', async () => {
    const { g, d } = gate({ mode: 'off', failOpen: false });
    await g.check(req, await files(`%PDF ${EICAR}`));
    expect(av.seen.commands).toEqual([]); expect(d.count).not.toHaveBeenCalled(); expect(g.enabled).toBe(false);
  });

  it('lets clean files through and counts them', async () => {
    const { g, d } = gate({ mode: 'enforce', failOpen: false });
    await g.check(req, await files('%PDF-1.4 a', '%PDF-1.4 b'));
    expect(d.count.mock.calls.map((c) => c[0])).toEqual(['clean', 'clean']);
  });

  it('refuses the whole request when any file is infected, names the file but not the signature, and records it', async () => {
    const { g, d } = gate({ mode: 'enforce', failOpen: true }); // even when failing open: an infection is a verdict, not an outage
    const err = await g.check(req, await files('%PDF-1.4 fine', `%PDF-1.4 ${EICAR}`, '%PDF-1.4 also fine')).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'malware_detected' });
    expect(err.message).toContain('"doc-1.pdf" was blocked'); expect(err.message).not.toMatch(/Eicar|signature/i);
    expect(d.blocked).toHaveBeenCalledWith(req, 'Eicar-Test-Signature');
    expect(d.count).toHaveBeenCalledWith('infected');
    expect(d.log.warn).toHaveBeenCalled();
  });

  it('fails closed by default: an unreachable scanner pauses uploads, with a plain message', async () => {
    const { g, d } = gate({ mode: 'enforce', failOpen: false }, deps(), scanner({ port: 1 }));
    const err = await g.check(req, await files('%PDF-1.4 a')).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: 'scanner_unavailable' });
    expect(err.message).not.toMatch(/ECONN|clamd|127\.0\.0\.1/);
    expect(d.count).toHaveBeenCalledWith('error'); expect(d.log.error).toHaveBeenCalled();
  });

  it('can fail open, accepting the upload with a warning and a count', async () => {
    const { g, d } = gate({ mode: 'enforce', failOpen: true }, deps(), scanner({ port: 1 }));
    await expect(g.check(req, await files('%PDF-1.4 a'))).resolves.toBeUndefined();
    expect(d.count).toHaveBeenCalledWith('error_allowed'); expect(d.log.warn).toHaveBeenCalled();
  });

  it('says so when a file is too big for the scanner (and does not call that "unavailable")', async () => {
    av.streamMax = 1000;
    const { g } = gate({ mode: 'enforce', failOpen: false });
    const err = await g.check(req, await files(randomBytes(500_000))).catch((e) => e);
    expect(err).toMatchObject({ status: 413, code: 'scan_too_large' });
  });

  it('scans a few files at a time, not all at once', async () => {
    av.replyDelayMs = 80;
    const real = scanner();
    let running = 0, most = 0;
    const counting = { ping: () => real.ping(), scan: async (p: string) => { running++; most = Math.max(most, running); try { return await real.scan(p); } finally { running--; } } };
    const { g } = gate({ mode: 'enforce', failOpen: false }, deps(), counting as never);
    await g.check(req, await files(...Array.from({ length: 9 }, (_, i) => `%PDF-1.4 ${i}`)));
    expect(av.seen.streams).toHaveLength(9);
    expect(most).toBe(3); // really parallel, and never more than the limit
  });
});
