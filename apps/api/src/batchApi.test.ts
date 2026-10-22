import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, JobModel, MemberModel, TeamModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { memberKey, poolKey } from './modules/teams/plan.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }

async function signup(plan: 'free' | 'pro' = 'pro'): Promise<U> {
  const email = `b${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'B' });
  expect(r.status).toBe(201);
  if (plan !== 'free') await UserModel.updateOne({ email }, { plan });
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([200, 200]); return Buffer.from(await d.save()); };
/** A file that passes the type check (it starts with %PDF) but is padded to `bytes`. */
const padded = (bytes: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(bytes, 0x20)]);

const send = async (u: U | null, tool: string, files: { buf: Buffer; name: string }[], o: { query?: string; options?: object } = {}) => {
  let r = request(ctx.app).post(`/api/pdf/${tool}${o.query ?? '?batch=1'}`);
  if (u) r = r.set(bearer(u.token));
  if (o.options) r = r.field('options', JSON.stringify(o.options));
  for (const f of files) r = r.attach('files', f.buf, f.name);
  return r;
};
const set = async (count: number, pages = 1) => Promise.all(Array.from({ length: count }, async (_, i) => ({ buf: await pdf(pages), name: `doc-${i}.pdf` })));
async function waitDone(token: string, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const r = await request(ctx.app).get(`/api/jobs/${jobId}`).set(bearer(token));
    if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error('timeout');
}
const totalOps = async (id: string) => ctx.usage.ops(`u:${id}`);
async function settle(u: U, expectOps: number) { for (let i = 0; i < 200 && (await totalOps(u.id)) < expectOps; i++) await new Promise((x) => setTimeout(x, 15)); }
const download = async (u: U, job: { result: { downloadUrl: string } }) => request(ctx.app).get(job.result.downloadUrl).set(bearer(u.token)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'bt-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123', DAILY_OPS_GUEST: '100', DAILY_OPS_FREE: '100', TEAM_SEATS_PRO: '5',
  });
  ctx = await createApp({ env, mailer });
  const s = await ctx.settings.get();
  await ctx.settings.update({ ...s, plans: { ...s.plans, pro: { ...s.plans.pro, dailyOps: 10, batchFiles: 4, maxFileMB: 1, maxConcurrentJobs: 5 } } });
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('who may batch', () => {
  it('guests and free accounts are told it is a paid feature, and nothing is left reserved', async () => {
    const free = await signup('free');
    const g = await send(null, 'rotate', await set(2));
    expect(g.status).toBe(403); expect(g.body.error.code).toBe('upgrade_required'); expect(g.body.error.message).toMatch(/Sign in and upgrade/);
    const f = await send(free, 'rotate', await set(2));
    expect(f.status).toBe(403); expect(f.body.error.message).toMatch(/not included in your plan/);
    expect(await JobModel.countDocuments({ owner: `u:${free.id}` })).toBe(0);
    // an ordinary single-file job is unaffected
    expect((await send(free, 'rotate', await set(1), { query: '' })).status).toBe(202);
  });

  it('only one-file-in, one-file-out tools can be batched, whatever the plan', async () => {
    const pro = await signup();
    for (const tool of ['merge', 'redact', 'organize', 'compare', 'edit-content', 'fill-form']) {
      const r = await send(pro, tool, await set(2));
      expect(r.status, tool).toBe(400); expect(r.body.error.code, tool).toBe('not_batchable');
    }
    expect(await JobModel.countDocuments({ owner: `u:${pro.id}` })).toBe(0);
  });

  it('the administrator sets who gets it and how many files: a stored settings document from before the feature keeps the deployment default', async () => {
    const pro = await signup();
    const adminToken = (await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' })).body.data.accessToken as string;
    const cur = (await request(ctx.app).get('/api/admin/settings').set(bearer(adminToken))).body.data;
    expect(cur.plans.pro.batchFiles).toBe(4); expect(cur.plans.free.batchFiles).toBe(0);
    const put = (batchFiles: number) => request(ctx.app).put('/api/admin/settings').set(bearer(adminToken)).send({ ...cur, plans: { ...cur.plans, pro: { ...cur.plans.pro, batchFiles } } });
    expect((await put(0)).status).toBe(200); // switched off for Pro
    expect((await send(pro, 'rotate', await set(2))).status).toBe(403);
    expect((await put(4)).status).toBe(200);
    expect((await send(pro, 'rotate', await set(2))).status).toBe(202);
    expect((await put(501)).status).toBe(400); // out of range
  });
});

describe('running a batch', () => {
  it('turns every file into a result in one archive, counts one operation per file, and says what it did', async () => {
    const u = await signup();
    const r = await send(u, 'rotate', await set(3), { options: { angle: 180, pages: 'all' } });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const job = await waitDone(u.token, r.body.data.jobId);
    expect(job.state).toBe('completed');
    expect(job.stats).toMatchObject({ files: 3, processed: 3, failed: 0 });
    expect(job.result).toMatchObject({ name: 'batch-rotate-3-files.zip', mime: 'application/zip' });
    const dl = await download(u, job);
    expect(dl.status).toBe(200);
    const zip = unzipSync(new Uint8Array(dl.body as Buffer));
    const pdfs = Object.keys(zip).filter((k) => k.endsWith('.pdf'));
    expect(pdfs).toHaveLength(3);
    for (const k of pdfs) expect((await PDFDocument.load(zip[k]!)).getPage(0).getRotation().angle).toBe(180);
    expect(strFromU8(zip['batch-report.txt']!)).toMatch(/processed: 3, failed: 0/);
    await settle(u, 3);
    expect(await totalOps(u.id)).toBe(3);
    expect((await request(ctx.app).get('/api/me/usage').set(bearer(u.token))).body.data.today.ops).toBe(3);
  });

  it('a file that fails does not stop the others, is reported, and is not counted', async () => {
    const u = await signup();
    const files = [{ buf: await pdf(), name: 'good-1.pdf' }, { buf: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not really a pdf')]), name: 'bad.pdf' }, { buf: await pdf(), name: 'good-2.pdf' }];
    const r = await send(u, 'rotate', files, { options: { angle: 90, pages: 'all' } });
    expect(r.status).toBe(202);
    const job = await waitDone(u.token, r.body.data.jobId);
    expect(job.state).toBe('completed'); expect(job.stats).toMatchObject({ files: 3, processed: 2, failed: 1 });
    expect(job.warnings[0]).toMatch(/1 of 3 files could not be processed.*bad\.pdf/);
    await settle(u, 2);
    expect(await totalOps(u.id)).toBe(2);
  });

  it('is a failed job (and costs nothing) only when every file fails', async () => {
    const u = await signup();
    const bad = (name: string) => ({ buf: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('nope')]), name });
    const r = await send(u, 'rotate', [bad('x.pdf'), bad('y.pdf')], { options: { angle: 90, pages: 'all' } });
    const job = await waitDone(u.token, r.body.data.jobId);
    expect(job.state).toBe('failed'); expect(job.error.code).toBe('batch_failed');
    await new Promise((x) => setTimeout(x, 100));
    expect(await totalOps(u.id)).toBe(0);
  });

  it('checks the options and the file types up front, before any work', async () => {
    const u = await signup();
    expect((await send(u, 'rotate', await set(2), { options: { angle: 45 } })).status).toBe(400);
    const r = await send(u, 'rotate', [...(await set(1)), { buf: Buffer.from('MZ not a pdf'), name: 'evil.pdf' }]);
    expect(r.status).toBe(415);
    expect(await JobModel.countDocuments({ owner: `u:${u.id}`, state: { $in: ['uploading', 'queued', 'processing'] } })).toBe(0); // nothing left reserved
  });
});

describe('limits', () => {
  it('stops at the plan\'s file count, and leaves nothing reserved', async () => {
    const u = await signup();
    const r = await send(u, 'rotate', await set(5)); // this plan allows 4 files in a batch
    expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
    expect(await JobModel.countDocuments({ owner: `u:${u.id}`, state: { $in: ['uploading', 'queued', 'processing'] } })).toBe(0);
    expect((await send(u, 'rotate', await set(4))).status).toBe(202); // exactly the limit is fine
  });

  it('caps a batch\'s total size at four times the per-file limit, whether the size was declared up front or only seen once received', async () => {
    const u = await signup();
    const s0 = await ctx.settings.get();
    await ctx.settings.update({ ...s0, plans: { ...s0.plans, pro: { ...s0.plans.pro, batchFiles: 8 } } }); // room for more files than the size cap allows
    try {
      const file = (i: number) => ({ buf: padded(950_000), name: `f${i}.pdf` });
      // 5 x 0.95 MB = 4.75 MB: under the 5 MB declared-size allowance (cap + 1 MB for the form), over the 4 MB cap, so it is caught after receiving
      const after = await send(u, 'rotate', [0, 1, 2, 3, 4].map(file));
      expect(after.status).toBe(413); expect(after.body.error.code).toBe('batch_too_large'); expect(after.body.error.message).toMatch(/at most 4 MB/);
      // 6 x 0.95 MB = 5.7 MB: over even the declared allowance, refused before the upload is read
      const before = await send(u, 'rotate', [0, 1, 2, 3, 4, 5].map(file));
      expect(before.status).toBe(413); expect(before.body.error.code).toBe('batch_too_large');
      // right at the cap is accepted
      const ok = await send(u, 'rotate', await set(8));
      expect(ok.status).toBe(202);
      expect(await JobModel.countDocuments({ owner: `u:${u.id}`, state: 'uploading' })).toBe(0);
    } finally { await ctx.settings.update(s0); }
  });

  it('counts a batch as one operation per file against the daily limit, and says how many are left', async () => {
    const u = await signup(); // Pro in this test: 10 operations a day
    for (const k of [3, 4]) { const r = await send(u, 'rotate', await set(k)); expect(r.status).toBe(202); await waitDone(u.token, r.body.data.jobId); }
    await settle(u, 7);
    const over = await send(u, 'rotate', await set(4));
    expect(over.status).toBe(429); expect(over.body.error.code).toBe('quota_exceeded'); expect(over.body.error.message).toMatch(/batch of 4 files is more than the 3 operations left today/);
    const fits = await send(u, 'rotate', await set(3));
    expect(fits.status).toBe(202); await waitDone(u.token, fits.body.data.jobId);
    await settle(u, 10);
    const none = await send(u, 'rotate', await set(1), { query: '' });
    expect(none.status).toBe(429); expect(none.body.error.code).toBe('quota_exceeded');
  });

  it('two batches started together cannot both claim the last of the allowance', async () => {
    const u = await signup();
    await ctx.usage.increment([`u:${u.id}`], 'rotate', undefined, 5); // 5 of 10 used: room for one batch of 4, not two
    const [a, b] = await Promise.all([send(u, 'rotate', await set(4)), send(u, 'rotate', await set(4))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 429]);
    const loser = a.status === 429 ? a : b;
    expect(loser.body.error.code).toBe('quota_exceeded');
    const winner = a.status === 202 ? a : b;
    await waitDone(u.token, winner.body.data.jobId);
    await settle(u, 9);
    expect(await totalOps(u.id)).toBe(9);
    expect(await JobModel.countDocuments({ owner: `u:${u.id}`, state: 'uploading' })).toBe(0); // the loser left no reservation
  });
});

describe('inside a team\'s shared pool', () => {
  async function team(members = 1) {
    const owner = await signup('pro');
    const t = await request(ctx.app).post('/api/teams').set(bearer(owner.token)).send({ name: 'Acme Design' });
    const teamId = t.body.data.id as string;
    await TeamModel.updateOne({ _id: teamId }, { plan: 'pro' });
    const people: U[] = [];
    for (let i = 0; i < members; i++) { const m = await signup('free'); await MemberModel.create({ teamId, userId: m.id, role: 'member' }); people.push(m); }
    return { owner, teamId, people };
  }

  it('a member of a paying team can batch (the team\'s plan applies), and each file counts against the pool and the member\'s share, not their own counter', async () => {
    const t = await team(1); // pool = 10 x 2 = 20
    const [m] = t.people as [U];
    const r = await send(m, 'rotate', await set(3));
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await waitDone(m.token, r.body.data.jobId);
    for (let i = 0; i < 200 && (await ctx.usage.ops(poolKey(t.teamId))) < 3; i++) await new Promise((x) => setTimeout(x, 15));
    expect(await ctx.usage.ops(poolKey(t.teamId))).toBe(3);
    expect(await ctx.usage.ops(memberKey(t.teamId, m.id))).toBe(3);
    expect(await ctx.usage.ops(`u:${m.id}`)).toBe(0);
  });

  it('is refused when the batch would not fit the pool, or a person\'s limit inside it, and says which', async () => {
    const t = await team(1);
    const [m] = t.people as [U];
    await ctx.usage.increment([poolKey(t.teamId)], 'rotate', undefined, 18); // 2 of 20 left
    const noRoom = await send(m, 'rotate', await set(3));
    expect(noRoom.status).toBe(429); expect(noRoom.body.error.message).toMatch(/batch of 3 files is more than your team's shared allowance has left today \(2 of 20\)/);
    await ctx.usage.increment([poolKey(t.teamId)], 'rotate', undefined, -18);
    await TeamModel.updateOne({ _id: t.teamId }, { memberDailyCap: 2 });
    const capped = await send(m, 'rotate', await set(3));
    expect(capped.status).toBe(429); expect(capped.body.error.code).toBe('member_cap_reached'); expect(capped.body.error.message).toMatch(/batch of 3 files would take you past your team's limit of 2/);
    expect((await send(m, 'rotate', await set(2))).status).toBe(202);
  });
});

describe('what the client can see', () => {
  it('the public tool list says which tools can be batched, and the plans say how many files', async () => {
    const tools = (await request(ctx.app).get('/api/tools')).body.data as { id: string; batchable?: boolean }[];
    expect(tools.find((t) => t.id === 'rotate')!.batchable).toBe(true);
    expect(tools.find((t) => t.id === 'merge')!.batchable).toBeFalsy();
    const plans = (await request(ctx.app).get('/api/plans')).body.data as { id: string; batchFiles: number; features: string[] }[];
    expect(Object.fromEntries(plans.map((p) => [p.id, p.batchFiles]))).toMatchObject({ guest: 0, free: 0, pro: 4 });
  });
});
