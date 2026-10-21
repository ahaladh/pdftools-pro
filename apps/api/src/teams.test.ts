import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, AuditModel, InviteModel, MemberModel, TeamModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import type { StripeClient } from './modules/billing/service.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const calls = { customers: [] as Record<string, unknown>[], sessions: [] as Record<string, unknown>[], cancelled: [] as string[], failCancel: false };
const realStripe = new Stripe('sk_test_dummy');
const fakeStripe = {
  customers: { create: async (p: Record<string, unknown>) => { calls.customers.push(p); return { id: `cus_t${calls.customers.length}` }; } },
  checkout: { sessions: { create: async (p: Record<string, unknown>) => { calls.sessions.push(p); return { url: 'https://stripe.test/c/team' }; } } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/p/team' }) } },
  subscriptions: { cancel: async (id: string) => { if (calls.failCancel) throw new Error('stripe down'); calls.cancelled.push(id); } },
  webhooks: realStripe.webhooks,
} as unknown as StripeClient;

const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }
async function signup(opts: { verified?: boolean } = {}): Promise<U> {
  const email = `t${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: `User ${n}` });
  expect(r.status).toBe(201);
  if (opts.verified !== false) await UserModel.updateOne({ email }, { emailVerifiedAt: new Date() });
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
const api = (u: U) => ({
  get: (p: string) => request(ctx.app).get(p).set(bearer(u.token)),
  post: (p: string, b: object = {}) => request(ctx.app).post(p).set(bearer(u.token)).send(b),
  patch: (p: string, b: object = {}) => request(ctx.app).patch(p).set(bearer(u.token)).send(b),
  del: (p: string) => request(ctx.app).delete(p).set(bearer(u.token)),
});
const inviteToken = () => /token=([\w-]+)/.exec(mailer.sent[mailer.sent.length - 1]!.text)![1]!;
const me = async (u: U) => (await api(u).get('/api/me')).body.data;

// Stripe events
const event = (id: string, type: string, object: unknown) => JSON.stringify({ id, object: 'event', type, data: { object } });
const hook = (payload: string) => request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' })).send(payload);
let evt = 0;
const subscribeTeam = async (teamId: string, plan: 'pro' | 'business', status = 'active', subId = `sub_team_${evt}`) =>
  hook(event(`evt_team_${evt++}`, status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', {
    id: subId, customer: 'cus_team', status, metadata: { teamId }, cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, items: { data: [{ price: { id: plan === 'pro' ? 'price_pro' : 'price_biz' } }] },
  }));

/** Owner with a team of the given plan, plus any number of verified members already joined. */
async function teamWith(plan: 'free' | 'pro' | 'business', members = 0) {
  const owner = await signup();
  const t = await api(owner).post('/api/teams', { name: 'Acme Design' });
  expect(t.status).toBe(201);
  const teamId = t.body.data.id as string;
  if (plan !== 'free') expect((await subscribeTeam(teamId, plan)).status).toBe(200);
  const joined: U[] = [];
  for (let i = 0; i < members; i++) {
    const m = await signup();
    expect((await api(owner).post('/api/teams/mine/invites', { email: m.email })).status).toBe(201);
    expect((await api(m).post('/api/teams/invites/accept', { token: inviteToken() })).status).toBe(200);
    joined.push(m);
  }
  return { owner, teamId, members: joined };
}
const pdf = async () => Buffer.from(await (async () => { const d = await PDFDocument.create(); d.addPage([200, 200]); return d.save(); })());

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'teams-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_biz', STRIPE_WEBHOOK_SECRET: 'whsec_test', DAILY_OPS_FREE: '50',
    TEAM_SEATS_PRO: '3', TEAM_SEATS_BUSINESS: '10',
  });
  ctx = await createApp({ env, mailer, stripe: fakeStripe });
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('creating a team', () => {
  it('makes the creator its owner; free teams have one seat; a person can be in only one team', async () => {
    const u = await signup();
    expect((await api(u).get('/api/teams/mine')).body.data).toBeNull();
    const r = await api(u).post('/api/teams', { name: '  Acme  ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ name: 'Acme', myRole: 'owner', plan: 'free', seats: 1, seatsUsed: 1, invites: [] });
    expect(r.body.data.members).toEqual([expect.objectContaining({ email: u.email, role: 'owner', you: true })]);
    expect((await me(u)).team).toMatchObject({ name: 'Acme', role: 'owner', plan: 'free' });
    expect((await api(u).post('/api/teams', { name: 'Second' })).status).toBe(409);
    expect((await api(u).post('/api/teams', { name: 'x' })).status).toBe(400); // too short
    expect((await request(ctx.app).post('/api/teams').send({ name: 'Anon team' })).status).toBe(401);
  });

  it('two simultaneous creations leave exactly one team (the database decides)', async () => {
    const u = await signup();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => api(u).post('/api/teams', { name: `Race ${i}` })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await MemberModel.countDocuments({ userId: u.id })).toBe(1);
    expect(await TeamModel.countDocuments({ ownerId: u.id })).toBe(1); // the losers cleaned up their teams
  });
});

describe('inviting and joining', () => {
  it('a free team has no room; once the team subscribes, members can be invited and share its plan', async () => {
    const owner = await signup();
    const team = (await api(owner).post('/api/teams', { name: 'Acme' })).body.data;
    const guest = await signup();
    const none = await api(owner).post('/api/teams/mine/invites', { email: guest.email });
    expect(none.status).toBe(409); expect(none.body.error.code).toBe('no_seats');
    expect((await subscribeTeam(team.id, 'pro')).status).toBe(200);
    expect((await api(owner).get('/api/teams/mine')).body.data).toMatchObject({ plan: 'pro', seats: 3 });

    expect((await me(guest)).effectivePlan).toBe('free');
    const inv = await api(owner).post('/api/teams/mine/invites', { email: guest.email });
    expect(inv.status).toBe(201);
    expect(inv.body.data.invites).toEqual([expect.objectContaining({ email: guest.email, role: 'member' })]);
    expect(inv.body.data.seatsUsed).toBe(2);
    expect(mailer.sent[mailer.sent.length - 1]).toMatchObject({ to: guest.email });
    expect(mailer.sent[mailer.sent.length - 1]!.text).toContain('/team/join?token=');

    const token = inviteToken();
    expect(JSON.stringify((await InviteModel.findOne({ email: guest.email }))!.toObject())).not.toContain(token); // stored hashed
    const joined = await api(guest).post('/api/teams/invites/accept', { token });
    expect(joined.status).toBe(200); expect(joined.body.data).toMatchObject({ myRole: 'member', plan: 'pro' });
    expect(joined.body.data.invites).toEqual([]); // members never see invitations
    expect(joined.body.data.subscription).toBeUndefined(); // ...nor billing
    const after = await me(guest);
    expect(after.plan).toBe('free'); // their own plan is unchanged
    expect(after.effectivePlan).toBe('pro'); // what applies is the team's
    expect(after.team).toMatchObject({ role: 'member', plan: 'pro' });
  });

  it('the shared plan really changes what a member can do', async () => {
    const t = await teamWith('pro', 1);
    const outsider = await signup();
    const redact = (u: U) => request(ctx.app).post('/api/pdf/compare').set(bearer(u.token)).attach('files', Buffer.from('%PDF-1.4'), 'a.pdf');
    const blocked = await redact(outsider);
    expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe('upgrade_required'); // premium tool, free plan
    const allowed = await redact(t.members[0]!);
    expect(allowed.status).not.toBe(403); // the team's plan unlocks it
    expect((await api(t.members[0]!).get('/api/me/usage')).body.data.plan).toBe('pro');
    expect((await api(t.members[0]!).get('/api/me/usage')).body.data.limits.maxFileMB).toBe(200);
    void pdf;
  });

  it('an invitation is single use, email-bound, needs a confirmed address, and can expire', async () => {
    const t = await teamWith('pro');
    const target = await signup();
    await api(t.owner).post('/api/teams/mine/invites', { email: target.email });
    const token = inviteToken();

    const stranger = await signup();
    const wrong = await api(stranger).post('/api/teams/invites/accept', { token });
    expect(wrong.status).toBe(403); expect(wrong.body.error.code).toBe('wrong_account');
    expect(wrong.body.error.message).not.toContain(target.email); // only a masked hint
    expect(await InviteModel.countDocuments({ email: target.email })).toBe(1); // a wrong person does not burn it

    await UserModel.updateOne({ email: target.email }, { $unset: { emailVerifiedAt: 1 } });
    const unverified = await api(target).post('/api/teams/invites/accept', { token });
    expect(unverified.status).toBe(403); expect(unverified.body.error.code).toBe('email_unverified');
    await UserModel.updateOne({ email: target.email }, { emailVerifiedAt: new Date() });

    expect((await api(target).post('/api/teams/invites/accept', { token })).status).toBe(200);
    expect((await api(target).post('/api/teams/invites/accept', { token })).status).toBe(400); // used up
    expect((await api(stranger).post('/api/teams/invites/accept', { token })).status).toBe(400);

    for (const bad of ['x'.repeat(43), 'short']) expect((await api(stranger).post('/api/teams/invites/accept', { token: bad })).status).toBe(400);
    const later = await signup();
    await api(t.owner).post('/api/teams/mine/invites', { email: later.email });
    const t2 = inviteToken();
    await InviteModel.updateOne({ email: later.email }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await api(later).post('/api/teams/invites/accept', { token: t2 })).status).toBe(400);
    expect((await api(t.owner).get('/api/teams/mine')).body.data.invites).toEqual([]); // expired ones do not show or hold a seat
  });

  it('accepting twice in parallel joins exactly once', async () => {
    const t = await teamWith('pro');
    const u = await signup();
    await api(t.owner).post('/api/teams/mine/invites', { email: u.email });
    const token = inviteToken();
    const rs = await Promise.all(Array.from({ length: 6 }, () => api(u).post('/api/teams/invites/accept', { token })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await MemberModel.countDocuments({ userId: u.id })).toBe(1);
  });

  it('someone already in a team cannot join another, and the invitation is not wasted', async () => {
    const a = await teamWith('pro'); const b = await teamWith('pro');
    const u = await signup();
    await api(a.owner).post('/api/teams/mine/invites', { email: u.email }); const ta = inviteToken();
    await api(b.owner).post('/api/teams/mine/invites', { email: u.email }); const tb = inviteToken();
    expect((await api(u).post('/api/teams/invites/accept', { token: ta })).status).toBe(200);
    const r = await api(u).post('/api/teams/invites/accept', { token: tb });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('already_in_team');
    expect(await InviteModel.countDocuments({ email: u.email })).toBe(1); // B's invitation is still there for later
  });

  it('refuses duplicates, existing members and malformed addresses', async () => {
    const t = await teamWith('pro', 1);
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: t.members[0]!.email })).body.error.code).toBe('already_member');
    const x = await signup();
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: x.email })).status).toBe(201);
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: x.email.toUpperCase() })).body.error.code).toBe('already_invited');
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: 'not-an-email' })).status).toBe(400);
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: 'a@b.co', role: 'owner' })).status).toBe(400); // cannot invite an owner
  });
});

describe('seats', () => {
  it('members and pending invitations share the plan\'s seats; cancelling frees one', async () => {
    const t = await teamWith('pro'); // 3 seats, owner holds one
    const mk = async () => { const u = await signup(); return u; };
    const [a, b, c] = [await mk(), await mk(), await mk()];
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: a.email })).status).toBe(201);
    const second = await api(t.owner).post('/api/teams/mine/invites', { email: b.email });
    expect(second.status).toBe(201); expect(second.body.data).toMatchObject({ seats: 3, seatsUsed: 3 });
    const full = await api(t.owner).post('/api/teams/mine/invites', { email: c.email });
    expect(full.status).toBe(409); expect(full.body.error.code).toBe('no_seats');
    const id = second.body.data.invites.find((i: { email: string }) => i.email === b.email).id;
    expect((await api(t.owner).del(`/api/teams/mine/invites/${id}`)).status).toBe(200);
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: c.email })).status).toBe(201);
  });

  it('racing invitations for the last seat never oversubscribe', async () => {
    const t = await teamWith('pro');
    const people = await Promise.all(Array.from({ length: 6 }, () => signup()));
    const rs = await Promise.all(people.map((p) => api(t.owner).post('/api/teams/mine/invites', { email: p.email })));
    const view = (await api(t.owner).get('/api/teams/mine')).body.data;
    expect(view.seatsUsed).toBeLessThanOrEqual(3);
    expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(rs.filter((r) => r.status === 201).length).toBeLessThanOrEqual(2); // 3 seats, the owner holds one
  });

  it('when invitations interleave (slow database), exactly the free seats are granted: not zero, not too many', async () => {
    // Force the bad interleaving deterministically: every request passes the seat check before any of them inserts, and every
    // insert lands before any request recounts. Without serialisation all six then see "over capacity" and back out, so nobody
    // gets a seat that was free.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const create = InviteModel.create.bind(InviteModel) as (...a: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(InviteModel, 'create').mockImplementation((async (...a: unknown[]) => { await sleep(60); const doc = await create(...a); await sleep(60); return doc; }) as never);
    // Back-outs are progressive (each delete lowers the next recount), so also hold the deletes until every recount has run.
    const del = InviteModel.deleteOne.bind(InviteModel) as (...a: unknown[]) => Promise<unknown>;
    const spyDel = vi.spyOn(InviteModel, 'deleteOne').mockImplementation((async (...a: unknown[]) => { await sleep(150); return del(...a); }) as never);
    try {
      const t = await teamWith('pro'); // 3 seats, the owner holds one => 2 free
      const people = await Promise.all(Array.from({ length: 6 }, () => signup()));
      const rs = await Promise.all(people.map((p) => api(t.owner).post('/api/teams/mine/invites', { email: p.email })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
      expect(rs.filter((r) => r.status === 409 && r.body.error.code === 'no_seats')).toHaveLength(4);
      expect((await api(t.owner).get('/api/teams/mine')).body.data.seatsUsed).toBe(3);
      // the lock is released afterwards, so a later change is not blocked
      expect((await TeamModel.findById(t.teamId))!.get('seatLockToken')).toBeFalsy();
    } finally { spy.mockRestore(); spyDel.mockRestore(); }
  });

  it('a lock left behind by a crashed request expires by itself; one that stays held gives a clear "busy" error, not a hang', async () => {
    const t = await teamWith('pro');
    const [a, b] = [await signup(), await signup()];
    await TeamModel.updateOne({ _id: t.teamId }, { $set: { seatLockToken: 'dead-holder', seatLockUntil: new Date(Date.now() - 1000) } });
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: a.email })).status).toBe(201);
    await TeamModel.updateOne({ _id: t.teamId }, { $set: { seatLockToken: 'live-holder', seatLockUntil: new Date(Date.now() + 60_000) } });
    const r = await api(t.owner).post('/api/teams/mine/invites', { email: b.email });
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('busy');
    // and a request that gave up must not have released somebody else's lock
    expect((await TeamModel.findById(t.teamId))!.get('seatLockToken')).toBe('live-holder');
  }, 20_000);

  it('a lapsed subscription shrinks the team to one seat without evicting anyone, and blocks new invitations', async () => {
    const t = await teamWith('pro', 2);
    expect((await subscribeTeam(t.teamId, 'pro', 'canceled', 'sub_lapse')).status).toBe(200);
    const v = (await api(t.owner).get('/api/teams/mine')).body.data;
    expect(v).toMatchObject({ plan: 'free', seats: 1 });
    expect(v.members).toHaveLength(3); // nobody is thrown out
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: (await signup()).email })).body.error.code).toBe('no_seats');
    expect((await me(t.members[0]!)).effectivePlan).toBe('free'); // and the shared plan is gone
  });
});

describe('roles and permissions', () => {
  it('members can look, nothing more', async () => {
    const t = await teamWith('business', 2);
    const [m, other] = t.members as [U, U];
    const x = await signup();
    expect((await api(m).get('/api/teams/mine')).status).toBe(200);
    const denied = [
      await api(m).post('/api/teams/mine/invites', { email: x.email }),
      await api(m).patch('/api/teams/mine', { name: 'Hijacked' }),
      await api(m).del(`/api/teams/mine/members/${other.id}`),
      await api(m).patch(`/api/teams/mine/members/${other.id}`, { role: 'admin' }),
      await api(m).post('/api/teams/mine/transfer', { userId: m.id }),
      await api(m).del('/api/teams/mine'),
      await api(m).post('/api/billing/team/checkout', { plan: 'pro' }),
      await api(m).post('/api/billing/team/portal'),
    ];
    for (const r of denied) expect(r.status).toBe(403);
    expect((await api(t.owner).get('/api/teams/mine')).body.data.name).toBe('Acme Design'); // nothing changed
  });

  it('admins manage people below them, not the owner, other admins, billing or roles', async () => {
    const t = await teamWith('business', 3);
    const [adm, peer, victim] = t.members as [U, U, U];
    expect((await api(t.owner).patch(`/api/teams/mine/members/${adm.id}`, { role: 'admin' })).status).toBe(200);
    expect((await api(t.owner).patch(`/api/teams/mine/members/${peer.id}`, { role: 'admin' })).status).toBe(200);
    const x = await signup(); const y = await signup();
    expect((await api(adm).post('/api/teams/mine/invites', { email: x.email })).status).toBe(201); // may invite members
    expect((await api(adm).post('/api/teams/mine/invites', { email: y.email, role: 'admin' })).status).toBe(403); // not admins
    expect((await api(adm).patch('/api/teams/mine', { name: 'Renamed by admin' })).status).toBe(200);
    expect((await api(adm).del(`/api/teams/mine/members/${peer.id}`)).status).toBe(403); // another admin
    expect((await api(adm).del(`/api/teams/mine/members/${t.owner.id}`)).status).toBe(403); // the owner
    expect((await api(adm).del(`/api/teams/mine/members/${adm.id}`)).status).toBe(400); // yourself: use Leave
    expect((await api(adm).patch(`/api/teams/mine/members/${victim.id}`, { role: 'admin' })).status).toBe(403); // roles are the owner's
    expect((await api(adm).post('/api/teams/mine/transfer', { userId: victim.id })).status).toBe(403);
    expect((await api(adm).del('/api/teams/mine')).status).toBe(403);
    expect((await api(adm).post('/api/billing/team/checkout', { plan: 'pro' })).status).toBe(403);
    expect((await api(adm).del(`/api/teams/mine/members/${victim.id}`)).status).toBe(200); // an ordinary member: yes
  });

  it('the owner can do everything except remove or demote themselves', async () => {
    const t = await teamWith('pro', 1);
    const m = t.members[0]!;
    expect((await api(t.owner).patch(`/api/teams/mine/members/${t.owner.id}`, { role: 'member' })).status).toBe(400);
    expect((await api(t.owner).del(`/api/teams/mine/members/${t.owner.id}`)).status).toBe(403);
    expect((await api(t.owner).patch(`/api/teams/mine/members/${m.id}`, { role: 'admin' })).status).toBe(200);
    expect((await api(t.owner).patch(`/api/teams/mine/members/${m.id}`, { role: 'owner' })).status).toBe(400); // the schema has no owner role
    expect((await api(t.owner).patch('/api/teams/mine', { name: 'Better Name' })).body.data.name).toBe('Better Name');
  });

  it('every id in a request is scoped to the caller\'s own team (no cross-team access)', async () => {
    const a = await teamWith('pro', 1); const b = await teamWith('pro', 1);
    const bInvitee = await signup();
    const inv = await api(b.owner).post('/api/teams/mine/invites', { email: bInvitee.email });
    const bInviteId = inv.body.data.invites[0].id;
    expect((await api(a.owner).del(`/api/teams/mine/invites/${bInviteId}`)).status).toBe(404);
    expect(await InviteModel.countDocuments({ _id: bInviteId })).toBe(1); // untouched
    expect((await api(a.owner).del(`/api/teams/mine/members/${b.members[0]!.id}`)).status).toBe(404);
    expect((await api(a.owner).patch(`/api/teams/mine/members/${b.members[0]!.id}`, { role: 'admin' })).status).toBe(404);
    expect((await api(a.owner).post('/api/teams/mine/transfer', { userId: b.members[0]!.id })).status).toBe(404);
    for (const bad of ['0'.repeat(24), 'not-hex', '../x']) expect((await api(a.owner).del(`/api/teams/mine/members/${bad}`)).status).toBe(404);
    expect(await MemberModel.countDocuments({ userId: b.members[0]!.id })).toBe(1);
    expect((await api(await signup()).get('/api/teams/mine')).body.data).toBeNull(); // no team: nothing to see
    expect((await api(await signup()).post('/api/teams/mine/invites', { email: 'a@b.co' })).status).toBe(404);
  });
});

describe('membership changes take effect immediately', () => {
  it('removing someone reverts their plan on their very next request', async () => {
    const t = await teamWith('business', 1);
    const m = t.members[0]!;
    expect((await api(m).get('/api/me/usage')).body.data.plan).toBe('business');
    expect((await api(t.owner).del(`/api/teams/mine/members/${m.id}`)).status).toBe(200);
    expect((await api(m).get('/api/me/usage')).body.data.plan).toBe('free'); // same access token, no re-login
    expect((await me(m)).team).toBeUndefined();
  });

  it('members can leave; owners cannot', async () => {
    const t = await teamWith('pro', 1);
    const m = t.members[0]!;
    const owner = await api(t.owner).post('/api/teams/mine/leave');
    expect(owner.status).toBe(409); expect(owner.body.error.code).toBe('owner_cannot_leave');
    expect((await api(m).post('/api/teams/mine/leave')).status).toBe(200);
    expect((await api(m).get('/api/teams/mine')).body.data).toBeNull();
    expect((await api(m).post('/api/teams/mine/leave')).status).toBe(404);
    expect((await api(t.owner).get('/api/teams/mine')).body.data.members).toHaveLength(1);
  });

  it('a person\'s own plan and their team\'s combine to the better one, never the worse', async () => {
    const t = await teamWith('pro', 1);
    const m = t.members[0]!;
    await UserModel.updateOne({ email: m.email }, { plan: 'business' });
    expect((await me(m)).effectivePlan).toBe('business'); // personally better than the team
    await UserModel.updateOne({ email: m.email }, { plan: 'free' });
    expect((await me(m)).effectivePlan).toBe('pro');
  });
});

describe('ownership transfer', () => {
  it('goes to a confirmed member, swaps the roles, and moves billing with it', async () => {
    const t = await teamWith('pro', 2);
    const [next, plain] = t.members as [U, U];
    const x = await signup();
    expect((await api(t.owner).post('/api/teams/mine/transfer', { userId: x.id })).status).toBe(404); // not in the team
    expect((await api(t.owner).post('/api/teams/mine/transfer', { userId: t.owner.id })).status).toBe(404); // not yourself
    await UserModel.updateOne({ email: next.email }, { $unset: { emailVerifiedAt: 1 } });
    expect((await api(t.owner).post('/api/teams/mine/transfer', { userId: next.id })).body.error.code).toBe('email_unverified');
    await UserModel.updateOne({ email: next.email }, { emailVerifiedAt: new Date() });

    const r = await api(t.owner).post('/api/teams/mine/transfer', { userId: next.id });
    expect(r.status).toBe(200); expect(r.body.data.myRole).toBe('admin'); // the old owner stays on as admin
    expect((await api(next).get('/api/teams/mine')).body.data.myRole).toBe('owner');
    expect((await api(next).post('/api/billing/team/checkout', { plan: 'business' })).status).toBe(409); // already subscribed: manage via portal
    expect((await api(next).post('/api/billing/team/portal')).status).toBe(200);
    expect((await api(t.owner).post('/api/billing/team/portal')).status).toBe(403); // the old owner lost billing
    expect((await api(plain).post('/api/teams/mine/transfer', { userId: plain.id })).status).toBe(403);
    expect(await AuditModel.countDocuments({ action: 'team.ownership_transferred', actor: `u:${t.owner.id}` })).toBe(1);
  });
});

describe('team billing', () => {
  it('only the owner can start checkout; the team (not the person) is the Stripe customer', async () => {
    const t = await teamWith('free', 0);
    const lone = await signup();
    expect((await api(lone).post('/api/billing/team/checkout', { plan: 'pro' })).status).toBe(404);
    expect((await request(ctx.app).post('/api/billing/team/checkout').send({ plan: 'pro' })).status).toBe(401);
    expect((await api(t.owner).post('/api/billing/team/checkout', { plan: 'free' })).status).toBe(400);
    calls.customers.length = 0; calls.sessions.length = 0;
    const r = await api(t.owner).post('/api/billing/team/checkout', { plan: 'business' });
    expect(r.status).toBe(200); expect(r.body.data.url).toBe('https://stripe.test/c/team');
    expect(calls.customers[0]).toMatchObject({ metadata: { teamId: t.teamId }, name: 'Acme Design' });
    expect(calls.sessions[0]).toMatchObject({ client_reference_id: `team:${t.teamId}`, subscription_data: { metadata: { teamId: t.teamId, plan: 'business' } }, line_items: [{ price: 'price_biz', quantity: 1 }] });
    expect(JSON.stringify(calls.sessions[0])).not.toContain('sk_test');
    expect((await UserModel.findById(t.owner.id))!.billing?.customerId).toBeUndefined(); // the owner personally is not billed
    expect((await api(t.owner).post('/api/billing/team/portal')).status).toBe(200);
  });

  it('webhooks update the team, not the owner, are idempotent, and lapse the shared plan on cancellation', async () => {
    const t = await teamWith('pro', 1); // a pro team has room for a member; upgrade it to business below
    expect((await subscribeTeam(t.teamId, 'business', 'active', 'sub_x')).status).toBe(200);
    expect((await TeamModel.findById(t.teamId))!.plan).toBe('business');
    expect((await UserModel.findById(t.owner.id))!.plan).toBe('free'); // the owner's personal plan is untouched
    expect((await me(t.members[0]!)).effectivePlan).toBe('business');
    const sameEvent = event('evt_dup_team', 'customer.subscription.updated', { id: 'sub_x', customer: 'cus_team', status: 'active', metadata: { teamId: t.teamId }, items: { data: [{ price: { id: 'price_pro' } }] } });
    expect((await hook(sameEvent)).body.duplicate).toBe(false);
    expect((await hook(sameEvent)).body.duplicate).toBe(true);
    expect((await TeamModel.findById(t.teamId))!.plan).toBe('pro'); // processed once
    expect((await subscribeTeam(t.teamId, 'pro', 'canceled', 'sub_x')).status).toBe(200);
    expect((await TeamModel.findById(t.teamId))!.plan).toBe('free');
    expect((await me(t.members[0]!)).effectivePlan).toBe('free');
  });

  it('an unknown price leaves the team plan alone, and an event for an unknown team is ignored', async () => {
    const t = await teamWith('pro', 0);
    const odd = event('evt_odd_price', 'customer.subscription.updated', { id: 'sub_o', customer: 'cus_o', status: 'active', metadata: { teamId: t.teamId }, items: { data: [{ price: { id: 'price_mystery' } }] } });
    expect((await hook(odd)).status).toBe(200);
    expect((await TeamModel.findById(t.teamId))!.plan).toBe('pro');
    const ghost = event('evt_ghost', 'customer.subscription.updated', { id: 'sub_g', customer: 'cus_ghost', status: 'active', metadata: { teamId: '0'.repeat(24) }, items: { data: [{ price: { id: 'price_biz' } }] } });
    expect((await hook(ghost)).status).toBe(200);
  });
});

describe('deleting teams and accounts', () => {
  it('deleting a team cancels its subscription and returns every member to their own plan', async () => {
    const t = await teamWith('business', 1);
    const subId = (await TeamModel.findById(t.teamId))!.billing.subscriptionId as string;
    calls.cancelled.length = 0;
    expect((await api(t.members[0]!).del('/api/teams/mine')).status).toBe(403);
    expect((await api(t.owner).del('/api/teams/mine')).status).toBe(200);
    expect(calls.cancelled).toContain(subId);
    expect(await TeamModel.countDocuments({ _id: t.teamId })).toBe(0);
    expect(await MemberModel.countDocuments({ teamId: t.teamId })).toBe(0);
    expect((await me(t.members[0]!)).effectivePlan).toBe('free');
  });

  it('if Stripe cannot cancel, the team is kept (no orphaned subscription that nobody can manage)', async () => {
    const t = await teamWith('pro', 0);
    calls.failCancel = true;
    try { expect((await api(t.owner).del('/api/teams/mine')).status).toBeGreaterThanOrEqual(500); } finally { calls.failCancel = false; }
    expect(await TeamModel.countDocuments({ _id: t.teamId })).toBe(1);
    expect((await api(t.owner).del('/api/teams/mine')).status).toBe(200); // works once Stripe is back
  });

  it('deleting an account: members just leave, a solo owner takes the team along, an owner with members must hand over first', async () => {
    const t = await teamWith('pro', 2);
    const [m1, m2] = t.members as [U, U];
    expect((await api(m1).del('/api/me')).status).toBe(400); // validation: needs the password
    expect((await request(ctx.app).delete('/api/me').set(bearer(m1.token)).send({ password: PW })).status).toBe(200);
    expect(await MemberModel.countDocuments({ userId: m1.id })).toBe(0);
    expect((await api(t.owner).get('/api/teams/mine')).body.data.members).toHaveLength(2);

    const blocked = await request(ctx.app).delete('/api/me').set(bearer(t.owner.token)).send({ password: PW });
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe('transfer_required');
    expect(await UserModel.countDocuments({ _id: t.owner.id })).toBe(1); // nothing was deleted
    await api(t.owner).post('/api/teams/mine/transfer', { userId: m2.id });
    expect((await request(ctx.app).delete('/api/me').set(bearer(t.owner.token)).send({ password: PW })).status).toBe(200);

    const solo = await teamWith('pro', 0);
    expect((await request(ctx.app).delete('/api/me').set(bearer(solo.owner.token)).send({ password: PW })).status).toBe(200);
    expect(await TeamModel.countDocuments({ _id: solo.teamId })).toBe(0);
  });
});

describe('audit trail', () => {
  it('records who did what to whom', async () => {
    const t = await teamWith('pro', 1);
    const m = t.members[0]!;
    await api(t.owner).patch(`/api/teams/mine/members/${m.id}`, { role: 'admin' });
    await api(t.owner).del(`/api/teams/mine/members/${m.id}`);
    const actions = (await AuditModel.find({ actor: `u:${t.owner.id}` })).map((a: { action: string }) => a.action);
    for (const a of ['team.created', 'team.invited', 'team.role_changed', 'team.member_removed']) expect(actions, a).toContain(a);
    expect((await AuditModel.findOne({ actor: `u:${m.id}`, action: 'team.joined' }))).toBeTruthy();
  });
});
