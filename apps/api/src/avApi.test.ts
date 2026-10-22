import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, AuditModel, JobModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { runDoctor } from './ops/doctor.js';
import { EICAR, FakeClamd } from './testing/fakeclamd.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
let av: FakeClamd;
const mailer = new CaptureMailer();
const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const pdf = async () => Buffer.from(await (async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return d.save(); })());
/** A real, parseable PDF that carries the EICAR test string in a comment (what a scanner sees; the PDF itself is harmless). */
const infected = async () => Buffer.concat([await pdf(), Buffer.from(`\n% ${EICAR}\n`)]);
async function signup() {
  const email = `av${n++}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'AV' });
  return { email, token: r.body.data.accessToken as string, id: r.body.data.user.id as string };
}
const send = (token: string | null, files: { buf: Buffer; name: string }[], tool = 'rotate', query = '') => {
  let r = request(ctx.app).post(`/api/pdf/${tool}${query}`);
  if (token) r = r.set(bearer(token));
  for (const f of files) r = r.attach('files', f.buf, f.name);
  return r;
};
async function waitDone(token: string | null, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const rq = request(ctx.app).get(`/api/jobs/${jobId}`); const r = token ? await rq.set(bearer(token)) : await rq;
    if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error('timeout');
}
const jobDirs = async () => { try { return (await readdir(join(storage, 'jobs'))).length; } catch { return 0; } };
const counter = async (result: string) => (await ctx.metrics.registry.getSingleMetricAsString('pdftools_av_scans_total')).split('\n').find((l) => l.includes(`result="${result}"`))?.split(' ').pop() ?? '0';

async function boot(extra: Record<string, string>) {
  storage = await mkdtemp(join(tmpdir(), 'av-api-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    DAILY_OPS_GUEST: '1000', DAILY_OPS_FREE: '1000', AV_MODE: 'enforce', CLAMD_PORT: String(av.port), AV_TIMEOUT_SECONDS: '2', ...extra,
  });
  ctx = await createApp({ env, mailer });
}

beforeAll(async () => { mongo = await MongoMemoryServer.create(); av = await new FakeClamd().start(); await boot({}); }, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await av.stop(); await rm(storage, { recursive: true, force: true }); });
beforeEach(() => av.reset());

describe('with scanning on (refuse when the scanner cannot answer)', () => {
  it('a clean file is scanned and processed as normal, for signed-in people and for guests', async () => {
    const u = await signup();
    const r = await send(u.token, [{ buf: await pdf(), name: 'ok.pdf' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await waitDone(u.token, r.body.data.jobId)).state).toBe('completed');
    const g = await send(null, [{ buf: await pdf(), name: 'guest.pdf' }]);
    expect(g.status).toBe(202);
    expect(av.seen.streams).toHaveLength(2);
    expect(av.seen.commands).toEqual(['zINSTREAM', 'zINSTREAM']);
  });

  it('an infected file is refused with a clear message, leaves nothing on disk or in the queue, and costs no quota', async () => {
    const u = await signup();
    const dirsBefore = await jobDirs();
    const r = await send(u.token, [{ buf: await infected(), name: 'invoice.pdf' }]);
    expect(r.status).toBe(422); expect(r.body.error.code).toBe('malware_detected');
    expect(r.body.error.message).toContain('"invoice.pdf" was blocked');
    expect(JSON.stringify(r.body)).not.toMatch(/eicar|signature/i);
    expect(await jobDirs()).toBe(dirsBefore);                                   // no upload directory left behind
    expect(await JobModel.countDocuments({ owner: `u:${u.id}` })).toBe(0);      // no job, no reservation
    expect(await ctx.usage.ops(`u:${u.id}`)).toBe(0);
    // and the slot is free straight away
    expect((await send(u.token, [{ buf: await pdf(), name: 'fine.pdf' }])).status).toBe(202);
  });

  it('records who was blocked (without exposing the signature to them), and counts it', async () => {
    const u = await signup();
    await send(u.token, [{ buf: await infected(), name: 'x.pdf' }]);
    const entry = await AuditModel.findOne({ action: 'upload.malware_blocked', actor: `u:${u.id}` }).lean();
    expect(entry).toMatchObject({ meta: { signature: 'Eicar-Test-Signature' } });
    const g = await send(null, [{ buf: await infected(), name: 'g.pdf' }]);
    expect(g.status).toBe(422);
    expect(await AuditModel.countDocuments({ action: 'upload.malware_blocked', actor: /^g:/ })).toBeGreaterThanOrEqual(1);
    expect(Number(await counter('infected'))).toBeGreaterThanOrEqual(2);
    expect(Number(await counter('clean'))).toBeGreaterThanOrEqual(1);
  });

  it('one infected file refuses the whole batch: nothing is processed or counted', async () => {
    const u = await signup();
    await (await import('./db/models.js')).UserModel.updateOne({ email: u.email }, { plan: 'pro' });
    const s = await ctx.settings.get();
    await ctx.settings.update({ ...s, plans: { ...s.plans, pro: { ...s.plans.pro, batchFiles: 5 } } });
    const files = [{ buf: await pdf(), name: 'a.pdf' }, { buf: await infected(), name: 'b.pdf' }, { buf: await pdf(), name: 'c.pdf' }];
    const r = await send(u.token, files, 'rotate', '?batch=1');
    expect(r.status).toBe(422); expect(r.body.error.message).toContain('"b.pdf" was blocked');
    expect(await JobModel.countDocuments({ owner: `u:${u.id}` })).toBe(0);
    expect(await ctx.usage.ops(`u:${u.id}`)).toBe(0);
  });

  it('files that fail the type check never reach the scanner', async () => {
    const u = await signup();
    const r = await send(u.token, [{ buf: Buffer.from('MZ this is not a pdf'), name: 'evil.pdf' }]);
    expect(r.status).toBe(415);
    expect(av.seen.commands).toEqual([]);
  });

  it('refuses uploads, with a plain message and no internals, while the scanner cannot answer', async () => {
    const u = await signup();
    const bigger = Buffer.concat([await pdf(), Buffer.alloc(300_000, 0x20)]); // several chunks, so the daemon can hang up part-way
    for (const behaviour of ['garbage', 'close-early'] as const) {
      av.behaviour = behaviour;
      const r = await send(u.token, [{ buf: bigger, name: 'a.pdf' }]);
      expect(r.status, behaviour).toBe(503); expect(r.body.error.code).toBe('scanner_unavailable');
      expect(JSON.stringify(r.body)).not.toMatch(/clamd|127\.0\.0\.1|ECONN|protocol/i);
    }
    expect(await JobModel.countDocuments({ owner: `u:${u.id}` })).toBe(0);
    expect(Number(await counter('error'))).toBeGreaterThanOrEqual(2);
  });

  it('says so when a file is bigger than the scanner will take, rather than calling it an outage', async () => {
    const u = await signup();
    av.streamMax = 500;
    const r = await send(u.token, [{ buf: await pdf(), name: 'big.pdf' }]);
    expect(r.status).toBe(413); expect(r.body.error.code).toBe('scan_too_large');
  });
});

describe('doctor checks the scanner', () => {
  it('reports it reachable, and unreachable as a failure while uploads would be refused', async () => {
    const base = { NODE_ENV: 'test', AV_MODE: 'enforce', CLAMD_PORT: String(av.port), STORAGE_DIR: storage };
    const up = (await runDoctor(loadEnv(base))).checks.find((c) => c.name === 'antivirus scanner')!;
    expect(up).toMatchObject({ level: 'pass', detail: expect.stringContaining('ClamAV 1.4.0') });
    const gone = new FakeClamd(); await gone.start(); const deadPort = gone.port; await gone.stop();
    const down = (await runDoctor(loadEnv({ ...base, CLAMD_PORT: String(deadPort) }))).checks.find((c) => c.name === 'antivirus scanner')!;
    expect(down.level).toBe('fail'); expect(down.detail).toMatch(/every upload would be refused/);
    const downOpen = (await runDoctor(loadEnv({ ...base, CLAMD_PORT: String(deadPort), AV_FAIL: 'open' }))).checks.find((c) => c.name === 'antivirus scanner')!;
    expect(downOpen.level).toBe('warn'); expect(downOpen.detail).toMatch(/accepted unscanned/);
    // switched off: no live check at all, and the static line says so
    const off = (await runDoctor(loadEnv({ NODE_ENV: 'test', STORAGE_DIR: storage }))).checks;
    expect(off.find((c) => c.name === 'antivirus scanner')).toBeUndefined();
    expect(off.find((c) => c.name === 'antivirus')!.detail).toMatch(/^off: uploads are not virus-scanned/);
  }, 60_000);
});

describe('with AV_FAIL=open (prefer availability)', () => {
  beforeAll(async () => { await ctx.close?.(); await rm(storage, { recursive: true, force: true }); await boot({ AV_FAIL: 'open' }); });

  it('lets uploads through with a warning while the scanner is down, but still blocks what the scanner does flag', async () => {
    const u = await signup();
    av.behaviour = 'garbage';
    const ok = await send(u.token, [{ buf: await pdf(), name: 'a.pdf' }]);
    expect(ok.status).toBe(202);
    expect(Number(await counter('error_allowed'))).toBeGreaterThanOrEqual(1);
    av.behaviour = 'normal';
    const bad = await send(u.token, [{ buf: await infected(), name: 'b.pdf' }]);
    expect(bad.status).toBe(422);
  });
});
