import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, AuditModel, InviteModel, MemberModel, TeamModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import type { StripeClient } from './modules/billing/service.js';
import { memberKey, poolKey } from './modules/teams/plan.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const calls = { cancelled: [] as string[], failCancel: false };
const realStripe = new Stripe('sk_test_dummy');
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_x' }) },
  checkout: { sessions: { create: async () => ({ url: 'https://stripe.test/c' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/p' }) } },
  subscriptions: { cancel: async (id: string) => { if (calls.failCancel) throw new Error('stripe down'); calls.cancelled.push(id); } },
  webhooks: realStripe.webhooks,
} as unknown as StripeClient;

const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }
async function signup(opts: { verified?: boolean } = {}): Promise<U> {
  const email = `at${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: `Person ${n}` });
  expect(r.status).toBe(201);
  if (opts.verified !== false) await UserModel.updateOne({ email }, { emailVerifiedAt: new Date() });
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
/** A team through the real endpoint, then its plan/subscription and members set directly (Stripe and invitations are tested elsewhere). */
async function team(o: { name?: string; plan?: 'free' | 'pro' | 'business'; members?: number; unverified?: boolean; sub?: string } = {}) {
  const owner = await signup();
  const r = await request(ctx.app).post('/api/teams').set(bearer(owner.token)).send({ name: o.name ?? `Team ${n}` });
  expect(r.status).toBe(201);
  const teamId = r.body.data.id as string;
  await TeamModel.updateOne({ _id: teamId }, { plan: o.plan ?? 'free', ...(o.sub ? { billing: { customerId: 'cus_secret_1', subscriptionId: o.sub, status: 'active', plan: o.plan ?? 'pro', currentPeriodEnd: new Date(Date.now() + 864e5), cancelAtPeriodEnd: false } } : {}) });
  const people: U[] = [];
  for (let i = 0; i < (o.members ?? 0); i++) { const m = await signup({ verified: !(o.unverified && i === 0) }); await MemberModel.create({ teamId, userId: m.id, role: 'member' }); people.push(m); }
  return { owner, teamId, people };
}
let admin: string;
const get = (p: string, t = admin) => request(ctx.app).get(p).set(bearer(t));
const post = (p: string, b: object, t = admin) => request(ctx.app).post(p).set(bearer(t)).send(b);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'at-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_biz', STRIPE_WEBHOOK_SECRET: 'whsec_test', TEAM_SEATS_PRO: '5',
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123',
  });
  ctx = await createApp({ env, mailer, stripe: fakeStripe });
  admin = (await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' })).body.data.accessToken;
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('access', () => {
  it('every team endpoint is for administrators only', async () => {
    const t = await team({ members: 1 }); const [m] = t.people as [U];
    for (const who of [undefined, m.token, t.owner.token]) {
      const a = (r: request.Test) => (who ? r.set(bearer(who)) : r);
      expect((await a(request(ctx.app).get('/api/admin/teams'))).status, 'list').toBe(who ? 403 : 401);
      expect((await a(request(ctx.app).get(`/api/admin/teams/${t.teamId}`))).status, 'detail').toBe(who ? 403 : 401);
      expect((await a(request(ctx.app).post(`/api/admin/teams/${t.teamId}/transfer`).send({ userId: m.id }))).status, 'transfer').toBe(who ? 403 : 401);
      expect((await a(request(ctx.app).delete(`/api/admin/teams/${t.teamId}`))).status, 'delete').toBe(who ? 403 : 401);
    }
    expect(await TeamModel.exists({ _id: t.teamId })).toBeTruthy();
    expect((await MemberModel.findOne({ userId: m.id }))!.role).toBe('member');
  });
});

describe('looking teams up', () => {
  it('lists teams with their owner, size, plan, subscription and today\'s pool, newest first, with paging', async () => {
    const t = await team({ name: 'Zeta Studio', plan: 'pro', members: 2, sub: 'sub_zeta' });
    await ctx.usage.increment([poolKey(t.teamId), memberKey(t.teamId, (t.people[0] as U).id)], 'merge');
    await InviteModel.create({ teamId: t.teamId, email: 'someone-secret@example.com', role: 'member', tokenHash: `h${n++}`.padEnd(64, 'x'), invitedBy: t.owner.id, expiresAt: new Date(Date.now() + 864e5) });
    const r = await get('/api/admin/teams?q=Zeta');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ total: 1, page: 1 });
    expect(r.body.data.rows[0]).toMatchObject({
      id: t.teamId, name: 'Zeta Studio', plan: 'pro', owner: { id: t.owner.id, email: t.owner.email }, members: 3, seats: 5, seatsUsed: 4,
      pool: { opsToday: 1, limit: 3 * 1000 }, subscription: { status: 'active', plan: 'pro' },
    });
    // paging and ordering
    for (let i = 0; i < 3; i++) await team({ name: `Pager ${i}` });
    const p1 = await get('/api/admin/teams?q=Pager&pageSize=2&page=1'), p2 = await get('/api/admin/teams?q=Pager&pageSize=2&page=2');
    expect(p1.body.data.total).toBe(3); expect(p1.body.data.rows).toHaveLength(2); expect(p2.body.data.rows).toHaveLength(1);
    expect(p1.body.data.rows.map((x: { name: string }) => x.name)).toEqual(['Pager 2', 'Pager 1']);
    expect(p1.body.data.rows[0].pool).toBeUndefined(); // a free team has no pool
  });

  it('finds a team by its name or its owner\'s email, case-insensitively, and treats the search as text, not a pattern', async () => {
    const t = await team({ name: 'Findable Co (EU)' });
    expect((await get('/api/admin/teams?q=findable co')).body.data.rows.map((x: { id: string }) => x.id)).toContain(t.teamId);
    expect((await get(`/api/admin/teams?q=${encodeURIComponent(t.owner.email.toUpperCase())}`)).body.data.rows.map((x: { id: string }) => x.id)).toEqual([t.teamId]);
    expect((await get(`/api/admin/teams?q=${encodeURIComponent('(EU)')}`)).body.data.total).toBe(1);
    expect((await get('/api/admin/teams?q=.*')).body.data.total).toBe(0); // not a regex
    expect((await get('/api/admin/teams?q=nothing-matches-this')).body.data).toMatchObject({ total: 0, rows: [] });
  });

  it('shows one team in full: members with their share of today\'s pool, pending invitations as a count, and no Stripe ids or invitee addresses', async () => {
    const t = await team({ plan: 'pro', members: 1, sub: 'sub_detail_secret' });
    const [m] = t.people as [U];
    await ctx.usage.increment([poolKey(t.teamId), memberKey(t.teamId, m.id)], 'merge');
    await ctx.usage.increment([poolKey(t.teamId), memberKey(t.teamId, m.id)], 'merge');
    await InviteModel.create({ teamId: t.teamId, email: 'invitee-secret@example.com', role: 'member', tokenHash: `h${n++}`.padEnd(64, 'x'), invitedBy: t.owner.id, expiresAt: new Date(Date.now() + 864e5) });
    const r = await get(`/api/admin/teams/${t.teamId}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: t.teamId, pendingInvites: 1, members: 2 });
    const byId = Object.fromEntries(r.body.data.memberList.map((x: { userId: string }) => [x.userId, x]));
    expect(byId[t.owner.id]).toMatchObject({ email: t.owner.email, role: 'owner', emailVerified: true, opsToday: 0 });
    expect(byId[m.id]).toMatchObject({ email: m.email, role: 'member', opsToday: 2 });
    const text = JSON.stringify(r.body);
    for (const secret of ['cus_secret_1', 'sub_detail_secret', 'invitee-secret@example.com', 'passwordHash', 'tokenHash']) expect(text).not.toContain(secret);
    expect((await get('/api/admin/teams/not-an-id')).status).toBe(404);
    expect((await get(`/api/admin/teams/${'0'.repeat(24)}`)).status).toBe(404);
  });

  it('the dashboard counts teams', async () => {
    const d = (await get('/api/admin/dashboard')).body.data.teams;
    expect(d.total).toBeGreaterThanOrEqual(5); expect(d.paid).toBeGreaterThanOrEqual(2);
  });
});

describe('handing a team to someone else (the owner cannot be reached)', () => {
  it('moves ownership to a member, keeps the old owner as an admin, and is audited with the administrator', async () => {
    const t = await team({ plan: 'pro', members: 2 });
    const [heir, other] = t.people as [U, U];
    const r = await post(`/api/admin/teams/${t.teamId}/transfer`, { userId: heir.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.owner).toMatchObject({ id: heir.id, email: heir.email });
    const roles = Object.fromEntries(r.body.data.memberList.map((x: { userId: string; role: string }) => [x.userId, x.role]));
    expect(roles).toEqual({ [heir.id]: 'owner', [t.owner.id]: 'admin', [other.id]: 'member' });
    expect(String((await TeamModel.findById(t.teamId))!.ownerId)).toBe(heir.id);
    // the new owner really has the powers: they can see billing and manage
    const view = await request(ctx.app).get('/api/teams/mine').set(bearer(heir.token));
    expect(view.body.data.myRole).toBe('owner');
    expect((await request(ctx.app).post('/api/teams/mine/invites').set(bearer(heir.token)).send({ email: `x${n++}@example.com` })).status).toBe(201);
    const adminUser = (await UserModel.findOne({ email: 'root@example.com' }))!;
    const entry = await AuditModel.findOne({ action: 'admin.team_ownership_transferred', target: `t:${t.teamId}` }).lean();
    expect(entry).toMatchObject({ actor: `u:${adminUser._id}`, meta: { from: t.owner.id, to: heir.id } });
  });

  it('refuses a stranger, the current owner, and someone who has not confirmed their email (they would take over billing)', async () => {
    const t = await team({ plan: 'pro', members: 1, unverified: true });
    const [unverified] = t.people as [U];
    const stranger = await signup();
    const expectOwnerUnchanged = async () => expect(String((await TeamModel.findById(t.teamId))!.ownerId)).toBe(t.owner.id);
    expect((await post(`/api/admin/teams/${t.teamId}/transfer`, { userId: stranger.id })).status).toBe(404);
    const same = await post(`/api/admin/teams/${t.teamId}/transfer`, { userId: t.owner.id });
    expect(same.status).toBe(409); expect(same.body.error.code).toBe('already_owner');
    const un = await post(`/api/admin/teams/${t.teamId}/transfer`, { userId: unverified.id });
    expect(un.status).toBe(409); expect(un.body.error.code).toBe('email_unverified');
    expect((await post(`/api/admin/teams/${t.teamId}/transfer`, { userId: 'nope' })).status).toBe(400);
    expect((await post(`/api/admin/teams/${t.teamId}/transfer`, {})).status).toBe(400);
    expect((await post(`/api/admin/teams/${'0'.repeat(24)}/transfer`, { userId: stranger.id })).status).toBe(404);
    await expectOwnerUnchanged();
    expect(await AuditModel.countDocuments({ action: 'admin.team_ownership_transferred', target: `t:${t.teamId}` })).toBe(0); // refusals leave no "transferred" trace
  });
});

describe('deleting a team', () => {
  it('cancels the subscription first, removes the team, its members\' membership, invitations and pool, and is audited; the people keep their accounts', async () => {
    const t = await team({ plan: 'pro', members: 1, sub: 'sub_to_cancel' });
    const [m] = t.people as [U];
    await ctx.usage.increment([poolKey(t.teamId), memberKey(t.teamId, m.id)], 'merge');
    await InviteModel.create({ teamId: t.teamId, email: `inv${n++}@example.com`, role: 'member', tokenHash: `h${n++}`.padEnd(64, 'x'), invitedBy: t.owner.id, expiresAt: new Date(Date.now() + 864e5) });
    const r = await request(ctx.app).delete(`/api/admin/teams/${t.teamId}`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(calls.cancelled).toContain('sub_to_cancel');
    expect(await TeamModel.exists({ _id: t.teamId })).toBeFalsy();
    expect(await MemberModel.countDocuments({ teamId: t.teamId })).toBe(0);
    expect(await InviteModel.countDocuments({ teamId: t.teamId })).toBe(0);
    expect(await ctx.usage.ops(poolKey(t.teamId))).toBe(0);
    expect((await request(ctx.app).get('/api/me').set(bearer(m.token))).body.data).toMatchObject({ email: m.email, effectivePlan: 'free' });
    expect((await request(ctx.app).get('/api/teams/mine').set(bearer(t.owner.token))).body.data).toBeNull();
    const entry = await AuditModel.findOne({ action: 'admin.team_deleted', target: `t:${t.teamId}` }).lean();
    expect(entry).toMatchObject({ meta: { members: 2, plan: 'pro' } });
    expect((await get(`/api/admin/teams/${t.teamId}`)).status).toBe(404);
    expect((await request(ctx.app).delete(`/api/admin/teams/${t.teamId}`).set(bearer(admin))).status).toBe(404); // already gone
  });

  it('keeps the team if the subscription cannot be cancelled (nobody is left paying for something they cannot manage)', async () => {
    const t = await team({ plan: 'pro', members: 1, sub: 'sub_stuck' });
    calls.failCancel = true;
    try {
      const r = await request(ctx.app).delete(`/api/admin/teams/${t.teamId}`).set(bearer(admin));
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally { calls.failCancel = false; }
    expect(await TeamModel.exists({ _id: t.teamId })).toBeTruthy();
    expect(await MemberModel.countDocuments({ teamId: t.teamId })).toBe(2);
    expect(await AuditModel.countDocuments({ action: 'admin.team_deleted', target: `t:${t.teamId}` })).toBe(0);
  });

  it('a team with no subscription is simply deleted', async () => {
    const t = await team({ plan: 'free' });
    const before = calls.cancelled.length;
    expect((await request(ctx.app).delete(`/api/admin/teams/${t.teamId}`).set(bearer(admin))).status).toBe(200);
    expect(calls.cancelled.length).toBe(before);
  });
});
