import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PDFDocument } from '@cantoo/pdf-lib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, MemberModel, TeamModel, UsageModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { poolKey, memberKey } from './modules/teams/plan.js';
import { Entitlements } from './modules/usage/entitlements.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const PW = 'correct horse battery';
const PRO_OPS = 3;
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }

async function signup(): Promise<U> {
  const email = `p${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: `U${n}` });
  expect(r.status).toBe(201);
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
/** A team on the given plan with `members` further members; memberships are written directly (invitations are tested elsewhere). */
async function team(plan: 'free' | 'pro' | 'business', members = 0) {
  const owner = await signup();
  const t = await request(ctx.app).post('/api/teams').set(bearer(owner.token)).send({ name: 'Acme Design' });
  expect(t.status).toBe(201);
  const teamId = t.body.data.id as string;
  await TeamModel.updateOne({ _id: teamId }, { plan });
  const joined: U[] = [];
  for (let i = 0; i < members; i++) { const m = await signup(); await MemberModel.create({ teamId, userId: m.id, role: 'member' }); joined.push(m); }
  return { owner, teamId, members: joined };
}
const pdf = async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return Buffer.from(await d.save()); };
async function waitDone(token: string, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await request(ctx.app).get(`/api/jobs/${jobId}`).set(bearer(token));
    if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error('timeout');
}
/** Submit one job; returns the response of the submission (and waits for the job when it was accepted, so it is counted). */
const totalOps = async () => ((await UsageModel.aggregate([{ $group: { _id: null, n: { $sum: '$ops' } } }])) as { n: number }[])[0]?.n ?? 0;
async function run(u: U, tool = 'rotate') {
  const before = await totalOps();
  const r = await request(ctx.app).post(`/api/pdf/${tool}`).set(bearer(u.token)).attach('files', await pdf(), 'a.pdf');
  if (r.status === 202) {
    expect((await waitDone(u.token, r.body.data.jobId)).state).toBe('completed');
    // the runner marks a job completed and then records its usage: wait for that, or the next request can see a stale count
    for (let i = 0; i < 200 && (await totalOps()) <= before; i++) await new Promise((x) => setTimeout(x, 10));
  }
  return r;
}
const usage = (u: U) => request(ctx.app).get('/api/me/usage').set(bearer(u.token)).then((r) => r.body.data);
const teamView = (u: U) => request(ctx.app).get('/api/teams/mine').set(bearer(u.token)).then((r) => r.body.data);
const ops = (key: string) => ctx.usage.ops(key);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'pool-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123', TEAM_SEATS_PRO: '5', DAILY_OPS_GUEST: '50', DAILY_OPS_FREE: '2',
  });
  ctx = await createApp({ env, mailer });
  const s = await ctx.settings.get();
  await ctx.settings.update({ ...s, plans: { ...s.plans, pro: { ...s.plans.pro, dailyOps: PRO_OPS }, business: { ...s.plans.business, dailyOps: 100 } } });
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('a paid team shares one daily allowance', () => {
  it('is dailyOps x members: one person can use far more than their own share, and everyone is stopped when it is gone', async () => {
    const t = await team('pro', 2); // 3 people x 3 = 9 shared operations
    const [a, b] = t.members as [U, U];
    for (let i = 0; i < 9; i++) expect((await run(a)).status, `job ${i + 1}`).toBe(202); // 3x what a person alone may do
    for (const who of [a, b, t.owner]) {
      const over = await run(who);
      expect(over.status).toBe(429); expect(over.body.error.code).toBe('quota_exceeded');
      expect(over.body.error.message).toMatch(/Acme Design.*shared allowance of 9 operations \(3 for each of its 3 members\)/);
    }
  });

  it('is counted on the team, with each person\'s share on the side, and never on their own counters', async () => {
    const t = await team('pro', 1);
    const [a] = t.members as [U];
    await run(a); await run(a); await run(t.owner);
    expect(await ops(poolKey(t.teamId))).toBe(3);
    expect(await ops(memberKey(t.teamId, a.id))).toBe(2);
    expect(await ops(memberKey(t.teamId, t.owner.id))).toBe(1);
    expect(await ops(`u:${a.id}`)).toBe(0); expect(await ops(`u:${t.owner.id}`)).toBe(0);
  });

  it('shows the pool to the person it gates, and the breakdown only to owners and admins', async () => {
    const t = await team('pro', 2);
    const [a, b] = t.members as [U, U];
    await run(a); await run(a); await run(b);
    const mine = await usage(a);
    expect(mine).toMatchObject({ today: { ops: 3, limit: 9 }, pool: { team: 'Acme Design', members: 3, yourOpsToday: 2 } });
    expect(mine.last30Days.at(-1)).toMatchObject({ ops: 3 }); // the pool's history, since that is what limits them
    expect((await usage(b)).pool.yourOpsToday).toBe(1);
    const ownerView = await teamView(t.owner);
    expect(ownerView.pool).toMatchObject({ opsToday: 3, limit: 9, perMember: 3 });
    expect(Object.fromEntries(ownerView.pool.byMember.map((m: { userId: string; ops: number }) => [m.userId, m.ops]))).toEqual({ [t.owner.id]: 0, [a.id]: 2, [b.id]: 1 });
    const memberView = await teamView(a);
    expect(memberView.pool).toMatchObject({ opsToday: 3, limit: 9 });
    expect(memberView.pool.byMember).toBeUndefined(); // other people's usage is for owners and admins
  });

  it('follows the team as it changes: a new member raises it, a departure lowers it, leaving the team costs nothing personal', async () => {
    const t = await team('pro', 2); // pool 9
    const [a, b] = t.members as [U, U];
    for (let i = 0; i < 9; i++) await run(a);
    expect((await run(b)).status).toBe(429);
    const c = await signup(); await MemberModel.create({ teamId: t.teamId, userId: c.id, role: 'member' });
    expect((await run(c)).status).toBe(202); // 4 people x 3 = 12, nine used
    expect(await usage(a)).toMatchObject({ today: { ops: 10, limit: 12 } });
    await MemberModel.deleteOne({ userId: c.id });
    expect((await run(b)).status).toBe(429); // back to 9 and ten used
    // a left the team after using 9: nothing of that is held against them personally
    await MemberModel.deleteOne({ userId: a.id });
    expect(await ops(`u:${a.id}`)).toBe(0);
    expect(await usage(a)).toMatchObject({ plan: 'free', today: { ops: 0, limit: 2 } });
    expect((await run(a)).status).toBe(202);
    expect(await ops(`u:${a.id}`)).toBe(1);
  });

  it('is the team\'s plan, so a lapsed subscription ends pooling at once and members are back on their own allowance', async () => {
    const t = await team('pro', 1);
    const [a] = t.members as [U];
    for (let i = 0; i < 4; i++) await run(a); // more than a person's own 3: only possible from the pool
    await TeamModel.updateOne({ _id: t.teamId }, { plan: 'free' });
    const u = await usage(a);
    expect(u.pool).toBeUndefined(); expect(u.plan).toBe('free'); expect(u.today).toMatchObject({ ops: 0, limit: 2 });
    expect((await run(a)).status).toBe(202);
    expect(await ops(`u:${a.id}`)).toBe(1);
    expect((await teamView(t.owner)).pool).toBeUndefined();
  });
});

describe('when it does not apply', () => {
  it('a team on the free plan has no pool: members use their own allowance', async () => {
    const t = await team('free');
    for (let i = 0; i < 2; i++) expect((await run(t.owner)).status).toBe(202);
    const over = await run(t.owner);
    expect(over.status).toBe(429); expect(over.body.error.message).not.toMatch(/team/i);
    expect(await ops(`u:${t.owner.id}`)).toBe(2); expect(await ops(poolKey(t.teamId))).toBe(0);
  });

  it('a person whose own plan is better keeps their own allowance and does not draw from (or feed) the pool', async () => {
    const t = await team('pro', 1);
    const [a] = t.members as [U];
    await UserModel.updateOne({ _id: a.id }, { plan: 'business' });
    for (let i = 0; i < 5; i++) expect((await run(a)).status).toBe(202); // business allows 100; the pool would have stopped them at 6
    expect(await ops(`u:${a.id}`)).toBe(5); expect(await ops(poolKey(t.teamId))).toBe(0);
    expect((await usage(a)).pool).toBeUndefined();
    // and they are not in the way of the others: the pool is still whole
    expect((await run(t.owner)).status).toBe(202);
  });

  it('an equal personal plan pools (the team allowance is at least as big), a lower one pools too', async () => {
    const t = await team('pro', 1);
    const [a] = t.members as [U];
    await UserModel.updateOne({ _id: a.id }, { plan: 'pro' });
    await run(a);
    expect(await ops(poolKey(t.teamId))).toBe(1); expect(await ops(`u:${a.id}`)).toBe(0);
  });

  it('guests and people without a team are unchanged', async () => {
    const solo = await signup();
    await run(solo);
    expect(await ops(`u:${solo.id}`)).toBe(1);
    expect((await usage(solo)).pool).toBeUndefined();
    const g = await request(ctx.app).post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    expect(g.status).toBe(202);
  });
});

describe('the check itself (unit)', () => {
  const settings = { get: async () => ({ maintenance: false, disabledTools: [], plans: { pro: { id: 'pro', name: 'Pro', dailyOps: 10, maxConcurrentJobs: 2, blockedTools: [] } } }), plan: async () => ({}) } as never;
  const mk = (used: number, active: Record<string, number>) => new Entitlements(settings, { ops: async () => used } as never, { activeCount: async (o: string) => active[o] ?? 0 } as never);
  const pooled = (members = ['a', 'b', 'c']) => ({ user: { plan: 'pro' }, effectivePlan: 'pro', owner: 'u:a', usageKeys: [], pool: { teamId: 't', teamName: 'Acme', key: 't:t', members: members.length, memberIds: members } }) as never;

  it('jobs in flight anywhere in the team count against the shared allowance, not only the caller\'s own', async () => {
    // pool = 10 x 3 = 30; 20 used, 6 + 4 in flight on two other members' accounts: 30 reached, so the next is refused
    const e = mk(20, { 'u:b': 1, 'u:c': 1 });
    await expect(mk(28, { 'u:b': 1, 'u:c': 1 }).check(pooled(), 'merge')).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(e.check(pooled(), 'merge')).resolves.toBeTruthy();
    await expect(mk(28, { 'u:a': 0, 'u:b': 0, 'u:c': 1 }).check(pooled(), 'merge')).resolves.toBeTruthy(); // 29 < 30
    await expect(mk(28, { 'u:a': 0, 'u:b': 1, 'u:c': 1 }).check(pooled(), 'merge')).rejects.toMatchObject({ code: 'quota_exceeded' }); // 30
  });
  it('concurrency stays personal: someone else\'s running jobs never stop you, your own do', async () => {
    await expect(mk(0, { 'u:b': 2, 'u:c': 2 }).check(pooled(), 'merge')).resolves.toBeTruthy();
    await expect(mk(0, { 'u:a': 2 }).check(pooled(), 'merge')).rejects.toMatchObject({ code: 'too_many_jobs' });
  });
});

describe('housekeeping', () => {
  it('deleting an account removes that person\'s share; deleting the team removes the pool and every share', async () => {
    const t = await team('pro', 2);
    const [a, b] = t.members as [U, U];
    await run(a); await run(b); await run(t.owner);
    const hasKey = (k: string) => UsageModel.exists({ key: k });
    expect(await hasKey(memberKey(t.teamId, b.id))).toBeTruthy();
    await ctx.usage.deleteMemberUsage(b.id);
    expect(await hasKey(memberKey(t.teamId, b.id))).toBeFalsy();
    expect(await hasKey(memberKey(t.teamId, a.id))).toBeTruthy(); // others untouched
    expect(await ops(poolKey(t.teamId))).toBe(3); // the pool total is the team's, not the person's
    // through the real endpoints: the owner deletes the team once the members are gone
    await MemberModel.deleteMany({ userId: { $in: [a.id, b.id] } });
    expect((await request(ctx.app).delete('/api/teams/mine').set(bearer(t.owner.token))).status).toBe(200);
    expect(await hasKey(poolKey(t.teamId))).toBeFalsy();
    expect(await UsageModel.countDocuments({ key: { $regex: `^tm:${t.teamId}:` } })).toBe(0);
  });

  it('the admin usage chart counts each operation once, even though it is recorded under several keys', async () => {
    const admin = (await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' })).body.data.accessToken as string;
    const total = async () => ((await request(ctx.app).get('/api/admin/usage?days=1').set(bearer(admin))).body.data.days as { ops: number }[]).reduce((s, d) => s + d.ops, 0);
    const before = await total();
    const t = await team('pro', 1);
    await run((t.members as [U])[0]);        // pooled: keys t:<team> and tm:<team>:<user>
    expect(await total()).toBe(before + 1);
    await run(t.owner);                       // pooled again
    const g = await request(ctx.app).post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf'); // guest: keys g:<id> and ip:<ip>
    expect(g.status).toBe(202);
    for (let i = 0; i < 200; i++) { if ((await total()) === before + 3) break; await new Promise((x) => setTimeout(x, 25)); }
    expect(await total()).toBe(before + 3);
  });
});
