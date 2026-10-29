import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, BillingEventModel, MemberModel, TeamModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { HttpRazorpay, RazorpayError, mapRazorpayStatus, verifyRazorpaySignature } from './modules/billing/razorpay.js';
import type { StripeClient } from './modules/billing/service.js';
import { FakeRazorpay } from './testing/fakerazorpay.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
let rz: FakeRazorpay;
const mailer = new CaptureMailer();
const SECRET = 'whsec_rz_test_secret';
const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }

async function signup(): Promise<U> {
  const email = `rz${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: `P${n}` });
  expect(r.status).toBe(201);
  await UserModel.updateOne({ email }, { emailVerifiedAt: new Date() });
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
const api = (u: U) => ({
  get: (p: string) => request(ctx.app).get(p).set(bearer(u.token)),
  post: (p: string, b: object = {}) => request(ctx.app).post(p).set(bearer(u.token)).send(b),
});
const user$ = (id: string) => UserModel.findById(id).lean<{ plan: string; billing?: { provider?: string; subscriptionId?: string; status?: string; cancelAtPeriodEnd?: boolean; currentPeriodEnd?: Date; seats?: number; eventAt?: number } }>();
const team$ = (id: string) => TeamModel.findById(id).lean<{ plan: string; billing?: { provider?: string; subscriptionId?: string; status?: string; seats?: number; cancelAtPeriodEnd?: boolean } }>();

/** What Razorpay sends. The signature is the hex HMAC-SHA256 of the exact body, computed here with node:crypto (and a known-answer vector below). */
let evt = 0;
interface Ent { id?: string; plan_id?: string; quantity?: number; status?: string; notes?: Record<string, string> | []; current_end?: number }
function deliver(entity: Ent, o: { event?: string; created_at?: number; eventId?: string | null; secret?: string; signature?: string | null } = {}) {
  const body = JSON.stringify({
    entity: 'event', event: o.event ?? 'subscription.activated', created_at: o.created_at ?? Math.floor(Date.now() / 1000),
    payload: { subscription: { entity: { id: 'sub_x', plan_id: 'plan_pro_rz', quantity: 1, status: 'active', notes: [], current_end: Math.floor(Date.now() / 1000) + 30 * 86400, customer_id: null, ...entity } } },
  });
  let r = request(ctx.app).post('/api/billing/razorpay/webhook').set('Content-Type', 'application/json');
  const sig = o.signature === undefined ? createHmac('sha256', o.secret ?? SECRET).update(body).digest('hex') : o.signature;
  if (sig !== null) r = r.set('X-Razorpay-Signature', sig);
  if (o.eventId !== null) r = r.set('X-Razorpay-Event-Id', o.eventId ?? `evt_rz_${evt++}`);
  return r.send(body);
}

/** A Stripe client that only has to exist (the Razorpay tests never reach it, except to prove a live Stripe subscription blocks a second purchase). */
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_x' }) }, checkout: { sessions: { create: async () => ({ url: 'https://stripe.test/c' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/p' }) } }, subscriptions: { cancel: async () => undefined }, webhooks: {},
} as unknown as StripeClient;

async function boot(extra: Record<string, string>, stripe: StripeClient | null = null) {
  storage = await mkdtemp(join(tmpdir(), 'rz-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    RAZORPAY_KEY_ID: rz.keyId, RAZORPAY_KEY_SECRET: rz.keySecret, RAZORPAY_WEBHOOK_SECRET: SECRET, RAZORPAY_API_BASE: rz.base,
    RAZORPAY_PLAN_PRO: 'plan_pro_rz', RAZORPAY_PLAN_BUSINESS: 'plan_biz_rz', ...extra,
  });
  ctx = await createApp({ env, mailer, stripe });
}

beforeAll(async () => { mongo = await MongoMemoryServer.create(); rz = await new FakeRazorpay().start(); await boot({ TEAM_BILLING: 'per_seat', TEAM_MIN_SEATS: '2', TEAM_MAX_SEATS: '20' }); }, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rz?.stop(); await rm(storage, { recursive: true, force: true }); });
beforeEach(() => rz.reset());

/** Buy Pro the way a person does: start checkout, then Razorpay's webhook says the first payment landed. */
async function subscribed(plan: 'pro' | 'business' = 'pro') {
  const u = await signup();
  const r = await api(u).post('/api/billing/checkout', { plan, provider: 'razorpay' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const subId = rz.lastId; // the subscription Razorpay (the fake) just created for this checkout
  const d = await deliver({ id: subId, plan_id: plan === 'pro' ? 'plan_pro_rz' : 'plan_biz_rz', notes: { userId: u.id, plan } });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return { u, subId };
}

describe('the signature check', () => {
  it('matches an independently computed HMAC (openssl) and rejects every near miss', () => {
    const body = Buffer.from('{"event":"subscription.activated"}');
    const good = '55315c5aae5cbfa687332d37d73e0263f703c425e9c3180247a39f73e2d5ed41'; // printf '%s' <body> | openssl dgst -sha256 -hmac whsec_rz_test_secret
    expect(verifyRazorpaySignature(body, good, SECRET)).toBe(true);
    expect(verifyRazorpaySignature(body, good.toUpperCase(), SECRET)).toBe(true); // hex is case-insensitive
    expect(verifyRazorpaySignature(body, good, 'another-secret')).toBe(false);
    expect(verifyRazorpaySignature(Buffer.from('{"event":"subscription.activated" }'), good, SECRET)).toBe(false); // one byte different
    expect(verifyRazorpaySignature(body, undefined, SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, '', SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, good.slice(0, 62), SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, `${good}00`, SECRET)).toBe(false);
    expect(verifyRazorpaySignature(body, 'z'.repeat(64), SECRET)).toBe(false);
  });

  it('maps Razorpay\'s states to ours; nothing is changed before the first payment', () => {
    expect(['active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired', 'created', 'authenticated', 'bogus'].map(mapRazorpayStatus))
      .toEqual(['active', 'past_due', 'unpaid', 'unpaid', 'canceled', 'canceled', 'canceled', null, null, null]);
  });
});

describe('checking the account (what the real service taught us)', () => {
  const probe = (id = rz.keyId, secret = rz.keySecret) => new HttpRazorpay(id, secret, rz.base).probe();
  it('tells a working account, wrong keys, and a missing Subscriptions product apart (Razorpay answers 401 to both of the last two)', async () => {
    expect(await probe()).toMatchObject({ ok: true, reason: 'ok' });
    expect(await probe('rzp_test_wrong', 'nope')).toMatchObject({ ok: false, reason: 'bad_keys' });
    rz.subscriptionsEnabled = false;
    expect(await probe()).toMatchObject({ ok: false, reason: 'subscriptions_not_enabled', detail: expect.stringContaining('Subscriptions is not enabled') });
    const down = await new HttpRazorpay(rz.keyId, rz.keySecret, 'http://127.0.0.1:1').probe();
    expect(down).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('reads both of Razorpay\'s error shapes: {error:{code,description}} and the bare {"error":"Unauthorized"}', async () => {
    const c = new HttpRazorpay(rz.keyId, rz.keySecret, rz.base);
    const req = { planId: 'p', quantity: 1, totalCount: 120, notes: {} };
    rz.subscriptionsEnabled = false;
    await expect(c.createSubscription(req)).rejects.toMatchObject({ status: 401, code: 'Unauthorized', message: 'Unauthorized' });
    rz.subscriptionsEnabled = true;
    rz.failNext = { status: 400, code: 'BAD_REQUEST_ERROR', description: 'The plan id provided does not exist' };
    const e = await c.createSubscription(req).catch((x) => x);
    expect(e).toBeInstanceOf(RazorpayError); expect(e).toMatchObject({ status: 400, code: 'BAD_REQUEST_ERROR', message: 'The plan id provided does not exist' });
  });

  it('a checkout on an account without Subscriptions is a plain error for the buyer (and the cause is in the log, not the page)', async () => {
    const u = await signup();
    rz.subscriptionsEnabled = false;
    const r = await api(u).post('/api/billing/checkout', { plan: 'pro' });
    expect(r.status).toBe(502); expect(r.body.error.code).toBe('billing_error');
    expect(JSON.stringify(r.body)).not.toMatch(/unauthorized|subscriptions/i);
  });
});

describe('offering Razorpay', () => {
  it('shows the gateway and which plans it can sell, and never leaks plan ids', async () => {
    const cfg = await request(ctx.app).get('/api/config');
    expect(cfg.body.data.features).toMatchObject({ billing: true, billingProviders: ['razorpay'] });
    const plans = (await request(ctx.app).get('/api/plans')).body.data as { id: string; purchasable: boolean; providers: string[] }[];
    expect(plans.find((p) => p.id === 'pro')).toMatchObject({ purchasable: true, providers: ['razorpay'] });
    expect(plans.find((p) => p.id === 'free')).toMatchObject({ purchasable: false, providers: [] });
    expect(JSON.stringify(plans)).not.toMatch(/plan_pro_rz|razorpayPlanId/);
  });

  it('asking for Stripe when only Razorpay is configured is refused clearly', async () => {
    const u = await signup();
    const r = await api(u).post('/api/billing/checkout', { plan: 'pro', provider: 'stripe' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('provider_unavailable');
    expect(rz.seen).toEqual([]);
  });

  it('is not offered without its webhook secret (a payment could never grant the plan), and the endpoint says so', async () => {
    await ctx.close?.(); await rm(storage, { recursive: true, force: true });
    await boot({ RAZORPAY_WEBHOOK_SECRET: '' });
    expect((await request(ctx.app).get('/api/config')).body.data.features).toMatchObject({ billing: false, billingProviders: [] });
    expect((await deliver({})).status).toBe(503);
    await ctx.close?.(); await rm(storage, { recursive: true, force: true });
    await boot({ TEAM_BILLING: 'per_seat', TEAM_MIN_SEATS: '2', TEAM_MAX_SEATS: '20' });
  });
});

describe('a person subscribes through Razorpay', () => {
  it('checkout creates one subscription with the right plan, buyer and authentication, and grants nothing yet', async () => {
    const u = await signup();
    const r = await api(u).post('/api/billing/checkout', { plan: 'pro', provider: 'razorpay' });
    expect(r.body.data.url).toMatch(/^https:\/\/rzp\.test\/sub_fake\d+$/);
    expect(rz.seen).toHaveLength(1);
    expect(rz.seen[0]).toMatchObject({
      method: 'POST', path: '/v1/subscriptions', auth: `Basic ${Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64')}`,
      body: { plan_id: 'plan_pro_rz', quantity: 1, total_count: 120, customer_notify: 1, notes: { userId: u.id, plan: 'pro' }, notify_info: { notify_email: u.email } },
    });
    expect((await user$(u.id))!.plan).toBe('free'); // paying is what grants the plan, not asking to pay
    // the default gateway is the only one configured, so the buyer need not name it
    expect((await api(u).post('/api/billing/checkout', { plan: 'business' })).status).toBe(200);
    expect(rz.seen[1]!.body).toMatchObject({ plan_id: 'plan_biz_rz' });
  });

  it('a signed "activated" event grants the plan, records the gateway and period, and the account shows it', async () => {
    const { u, subId } = await subscribed('pro');
    const d = (await user$(u.id))!;
    expect(d.plan).toBe('pro');
    expect(d.billing).toMatchObject({ provider: 'razorpay', subscriptionId: subId, status: 'active', cancelAtPeriodEnd: false });
    expect(d.billing!.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    const me = await api(u).get('/api/me');
    expect(me.body.data.subscription).toMatchObject({ status: 'active', plan: 'pro', provider: 'razorpay' });
    expect((await subscribed('business')).u.id).not.toBe(u.id);
  });

  it('refuses a plan with no Razorpay plan mapped, and a gateway failure is a plain error with no internals', async () => {
    const u = await signup();
    const s = await ctx.settings.get();
    await ctx.settings.update({ ...s, plans: { ...s.plans, business: { ...s.plans.business, razorpayPlanId: undefined } } });
    const none = await api(u).post('/api/billing/checkout', { plan: 'business' });
    expect(none.status).toBe(400); expect(none.body.error.code).toBe('plan_unavailable');
    await ctx.settings.update({ ...s });
    rz.failNext = { status: 400, code: 'BAD_REQUEST_ERROR', description: 'The plan id provided does not exist: internal detail' };
    const bad = await api(u).post('/api/billing/checkout', { plan: 'pro' });
    expect(bad.status).toBe(502); expect(bad.body.error.code).toBe('billing_error');
    expect(JSON.stringify(bad.body)).not.toMatch(/internal detail|razorpay|plan id/i);
  });

  it('refuses to start a second purchase while a subscription is live, whichever gateway holds it', async () => {
    const { u } = await subscribed('pro');
    const again = await api(u).post('/api/billing/checkout', { plan: 'business' });
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('already_subscribed');
    const other = await signup();
    await UserModel.updateOne({ _id: other.id }, { plan: 'pro', billing: { subscriptionId: 'sub_from_stripe', status: 'active', plan: 'pro' } }); // no provider recorded = Stripe
    expect((await api(other).post('/api/billing/checkout', { plan: 'pro' })).status).toBe(409);
  });
});

describe('the webhook', () => {
  it('rejects a missing, malformed, wrong-secret or tampered signature and changes nothing', async () => {
    const u = await signup();
    const recorded = await BillingEventModel.countDocuments({});
    const ent = { id: 'sub_forged', notes: { userId: u.id } };
    for (const o of [{ signature: null }, { signature: 'abc' }, { secret: 'not-the-secret' }] as const) {
      const r = await deliver(ent, o);
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('invalid_signature');
    }
    // a valid signature of a DIFFERENT body does not carry over to this one
    const other = createHmac('sha256', SECRET).update('{"event":"subscription.activated"}').digest('hex');
    expect((await deliver(ent, { signature: other })).status).toBe(400);
    expect((await user$(u.id))!.plan).toBe('free');
    expect(await BillingEventModel.countDocuments({})).toBe(recorded); // a refused delivery is not recorded as handled, so the real one is not mistaken for a replay
  });

  it('applies an event once: a replay with the same id is acknowledged and does nothing, even if its body differs', async () => {
    const u = await signup();
    const ent = { id: 'sub_once', notes: { userId: u.id } };
    const first = await deliver(ent, { eventId: 'evt_once' });
    expect(first.body).toMatchObject({ received: true, duplicate: false });
    const replay = await deliver({ ...ent, status: 'halted' }, { eventId: 'evt_once', event: 'subscription.halted' });
    expect(replay.status).toBe(200); expect(replay.body.duplicate).toBe(true);
    expect((await user$(u.id))!).toMatchObject({ plan: 'pro', billing: { status: 'active' } });
  });

  it('ignores an older event that arrives after a newer one', async () => {
    const u = await signup();
    const t = Math.floor(Date.now() / 1000);
    const ent = { id: 'sub_order', notes: { userId: u.id } };
    expect((await deliver({ ...ent, status: 'cancelled' }, { event: 'subscription.cancelled', created_at: t })).status).toBe(200);
    expect((await user$(u.id))!.plan).toBe('free');
    await deliver({ ...ent, status: 'active' }, { event: 'subscription.activated', created_at: t - 100 }); // sent earlier, arrives later
    expect((await user$(u.id))!).toMatchObject({ plan: 'free', billing: { status: 'canceled' } });
  });

  it('keeps access while a charge is retried, ends it when the retries run out, and on cancellation or completion', async () => {
    const { u, subId } = await subscribed('pro');
    const t = Math.floor(Date.now() / 1000);
    const step = async (status: string, event: string, k: number) => { expect((await deliver({ id: subId, status, notes: { userId: u.id } }, { event, created_at: t + k })).status).toBe(200); return (await user$(u.id))!; };
    expect(await step('pending', 'subscription.pending', 1)).toMatchObject({ plan: 'pro', billing: { status: 'past_due' } });
    expect(await step('active', 'subscription.charged', 2)).toMatchObject({ plan: 'pro', billing: { status: 'active' } });
    expect(await step('halted', 'subscription.halted', 3)).toMatchObject({ plan: 'free', billing: { status: 'unpaid' } });
    expect(await step('active', 'subscription.resumed', 4)).toMatchObject({ plan: 'pro' });
    expect(await step('cancelled', 'subscription.cancelled', 5)).toMatchObject({ plan: 'free', billing: { status: 'canceled' } });
    expect(await step('active', 'subscription.activated', 6)).toMatchObject({ plan: 'pro' }); // the same subscription may be revived
    expect(await step('completed', 'subscription.completed', 7)).toMatchObject({ plan: 'free', billing: { status: 'canceled' } });
  });

  it('does nothing before the first payment, for unknown owners, for other event kinds, and for a plan it cannot map', async () => {
    const u = await signup();
    await deliver({ id: 'sub_auth', status: 'authenticated', notes: { userId: u.id } }, { event: 'subscription.authenticated' });
    await deliver({ id: 'sub_nobody', notes: { userId: '0'.repeat(24) } });
    await deliver({ id: 'sub_pay', notes: { userId: u.id } }, { event: 'payment.captured' });
    await deliver({ id: 'sub_odd', plan_id: 'plan_not_ours', notes: { userId: u.id } });
    expect((await user$(u.id))!).toMatchObject({ plan: 'free' });
    expect((await user$(u.id))!.billing?.subscriptionId).toBeUndefined();
  });

  it('a second subscription cannot take over a live one (an old payment link paid late)', async () => {
    const { u, subId } = await subscribed('pro');
    const r = await deliver({ id: 'sub_extra', plan_id: 'plan_biz_rz', notes: { userId: u.id } }, { created_at: Math.floor(Date.now() / 1000) + 5 });
    expect(r.status).toBe(200);
    expect((await user$(u.id))!).toMatchObject({ plan: 'pro', billing: { subscriptionId: subId } });
  });

  it('finds the owner by subscription id when the notes are missing', async () => {
    const { u, subId } = await subscribed('pro');
    const t = Math.floor(Date.now() / 1000) + 10;
    expect((await deliver({ id: subId, status: 'halted' }, { event: 'subscription.halted', created_at: t })).status).toBe(200); // notes: [] as Razorpay sends when empty
    expect((await user$(u.id))!.plan).toBe('free');
  });
});

describe('a webhook that fails halfway', () => {
  it('is not marked as handled: Razorpay\'s retry of the same event applies it', async () => {
    const u = await signup();
    const spy = vi.spyOn(ctx.settings, 'get').mockRejectedValueOnce(new Error('database went away'));
    const first = await deliver({ id: 'sub_retry', notes: { userId: u.id } }, { eventId: 'evt_retry' });
    expect(first.status).toBeGreaterThanOrEqual(500);
    spy.mockRestore();
    expect((await user$(u.id))!.plan).toBe('free');
    const again = await deliver({ id: 'sub_retry', notes: { userId: u.id } }, { eventId: 'evt_retry' });
    expect(again.status).toBe(200); expect(again.body.duplicate).toBe(false);
    expect((await user$(u.id))!.plan).toBe('pro');
  });
});

describe('stopping and ending a subscription', () => {
  it('cancel stops renewal at the end of the paid period: the plan stays until Razorpay says the period ended', async () => {
    const { u, subId } = await subscribed('pro');
    const r = await api(u).post('/api/billing/cancel');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rz.seen.at(-1)).toMatchObject({ method: 'POST', path: `/v1/subscriptions/${subId}/cancel`, body: { cancel_at_cycle_end: 1 } });
    expect((await user$(u.id))!).toMatchObject({ plan: 'pro', billing: { cancelAtPeriodEnd: true } });
    expect((await api(u).get('/api/me')).body.data.subscription).toMatchObject({ cancelAtPeriodEnd: true, provider: 'razorpay' });
    // an ordinary renewal event must not forget the pending cancellation
    const t = Math.floor(Date.now() / 1000) + 20;
    await deliver({ id: subId, notes: { userId: u.id } }, { event: 'subscription.charged', created_at: t });
    expect((await user$(u.id))!.billing!.cancelAtPeriodEnd).toBe(true);
    // the end of the period
    await deliver({ id: subId, status: 'completed', notes: { userId: u.id } }, { event: 'subscription.completed', created_at: t + 1 });
    expect((await user$(u.id))!).toMatchObject({ plan: 'free', billing: { status: 'canceled', cancelAtPeriodEnd: false } });
  });

  it('has no billing portal to send people to, says so, and refuses to cancel what is not there', async () => {
    const { u } = await subscribed('pro');
    const p = await api(u).post('/api/billing/portal');
    expect(p.status).toBe(409); expect(p.body.error.code).toBe('no_portal');
    const free = await signup();
    expect((await api(free).post('/api/billing/cancel')).status).toBe(409);
    const stripeUser = await signup();
    await UserModel.updateOne({ _id: stripeUser.id }, { plan: 'pro', billing: { subscriptionId: 'sub_s', status: 'active', plan: 'pro', customerId: 'cus_s' } });
    const c = await api(stripeUser).post('/api/billing/cancel');
    expect(c.status).toBe(409); expect(c.body.error.code).toBe('use_portal'); // Stripe subscriptions are cancelled in Stripe's portal
  });

  it('a gateway failure while cancelling is reported and records nothing', async () => {
    const { u } = await subscribed('pro');
    rz.failNext = { status: 500, code: 'SERVER_ERROR', description: 'down' };
    const r = await api(u).post('/api/billing/cancel');
    expect(r.status).toBe(502);
    expect((await user$(u.id))!.billing!.cancelAtPeriodEnd).toBe(false);
  });

  it('deleting the account cancels the subscription at once (not at period end)', async () => {
    const { u, subId } = await subscribed('pro');
    const r = await request(ctx.app).delete('/api/me').set(bearer(u.token)).send({ password: PW });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rz.seen.at(-1)).toMatchObject({ path: `/v1/subscriptions/${subId}/cancel`, body: { cancel_at_cycle_end: 0 } });
  });
});

describe('a team pays per seat through Razorpay', () => {
  async function team(members = 0) {
    const owner = await signup();
    const t = await api(owner).post('/api/teams', { name: 'Acme Design' });
    expect(t.status).toBe(201);
    const teamId = t.body.data.id as string;
    const people: U[] = [];
    for (let i = 0; i < members; i++) { const m = await signup(); await MemberModel.create({ teamId, userId: m.id, role: 'member' }); people.push(m); }
    return { owner, teamId, people };
  }

  it('buys N seats as the subscription quantity, and the activation gives the whole team the plan and the seat count', async () => {
    const t = await team(1);
    const r = await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 5, provider: 'razorpay' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rz.seen[0]).toMatchObject({ body: { plan_id: 'plan_pro_rz', quantity: 5, notes: { teamId: t.teamId, plan: 'pro' }, notify_info: { notify_email: t.owner.email } } });
    expect((await team$(t.teamId))!.plan).toBe('free');
    await deliver({ id: 'sub_team1', quantity: 5, notes: { teamId: t.teamId } });
    expect(await team$(t.teamId)).toMatchObject({ plan: 'pro', billing: { provider: 'razorpay', status: 'active', seats: 5 } });
    const mine = (await api(t.owner).get('/api/teams/mine')).body.data;
    expect(mine.subscription).toMatchObject({ status: 'active', provider: 'razorpay' });
    expect(mine.seats).toBe(5);
  });

  it('seat limits apply as for Stripe: not below the people already there, not above the maximum', async () => {
    const t = await team(3); // 4 people
    expect((await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 3 })).status).toBe(400);
    expect((await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 99 })).status).toBe(400);
    expect(rz.seen).toEqual([]);
    expect((await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro' })).status).toBe(200);
    expect(rz.seen[0]!.body.quantity).toBe(4);
  });

  it('changes seats later through Razorpay; a refusal leaves the seat count and the charge untouched', async () => {
    const t = await team(1);
    await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 4 });
    const id = rz.lastId; // the subscription the fake just created for this team
    await deliver({ id, quantity: 4, notes: { teamId: t.teamId } });
    rz.reset();
    const up = await api(t.owner).post('/api/billing/team/seats', { seats: 6 });
    expect(up.status, JSON.stringify(up.body)).toBe(200); expect(up.body.data.seats).toBe(6);
    expect(rz.seen[0]).toMatchObject({ method: 'PATCH', path: `/v1/subscriptions/${id}`, body: { quantity: 6, schedule_change_at: 'now' } });
    expect((await team$(t.teamId))!.billing!.seats).toBe(6);
    rz.reset();
    expect((await api(t.owner).post('/api/billing/team/seats', { seats: 6 })).status).toBe(200);
    expect(rz.seen).toEqual([]); // no change, no call
    rz.failNext = { status: 400, code: 'BAD_REQUEST_ERROR', description: 'payment failed' };
    const bad = await api(t.owner).post('/api/billing/team/seats', { seats: 8 });
    expect(bad.status).toBe(402); expect(bad.body.error.code).toBe('payment_failed');
    expect((await team$(t.teamId))!.billing!.seats).toBe(6);
    rz.failNext = { status: 500, code: 'SERVER_ERROR', description: 'down' };
    expect((await api(t.owner).post('/api/billing/team/seats', { seats: 8 })).status).toBe(502);
    expect((await api(t.owner).post('/api/billing/team/seats', { seats: 1 })).status).toBe(400); // below the minimum
  });

  it('only the owner may buy, change or cancel; the team has no portal; cancelling stops renewal for the team', async () => {
    const t = await team(1);
    const member = t.people[0]!;
    for (const [path, body] of [['/api/billing/team/checkout', { plan: 'pro' }], ['/api/billing/team/seats', { seats: 3 }], ['/api/billing/team/cancel', {}]] as const) {
      expect((await api(member).post(path, body)).status, path).toBe(403);
    }
    await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 3 });
    const id = rz.lastId;
    await deliver({ id, quantity: 3, notes: { teamId: t.teamId } });
    expect((await api(t.owner).post('/api/billing/team/portal')).body.error.code).toBe('no_portal');
    expect((await api(t.owner).post('/api/billing/team/cancel')).status).toBe(200);
    expect(rz.seen.at(-1)).toMatchObject({ path: `/v1/subscriptions/${id}/cancel`, body: { cancel_at_cycle_end: 1 } });
    expect(await team$(t.teamId)).toMatchObject({ plan: 'pro', billing: { cancelAtPeriodEnd: true } });
  });

  it('deleting the team cancels its Razorpay subscription at once', async () => {
    const t = await team();
    await api(t.owner).post('/api/billing/team/checkout', { plan: 'pro', seats: 2 });
    const id = rz.lastId;
    await deliver({ id, quantity: 2, notes: { teamId: t.teamId } });
    rz.reset();
    const r = await request(ctx.app).delete('/api/teams/mine').set(bearer(t.owner.token)).send({ password: PW });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(rz.seen.at(-1)).toMatchObject({ path: `/v1/subscriptions/${id}/cancel`, body: { cancel_at_cycle_end: 0 } });
  });
});

describe('both gateways on one server', () => {
  it('offers both, defaults to Stripe, takes the asked-for one, and each plan lists only the gateways that can sell it', async () => {
    await ctx.close?.(); await rm(storage, { recursive: true, force: true });
    await boot({ STRIPE_PRICE_PRO: 'price_pro', STRIPE_WEBHOOK_SECRET: 'whsec_x' }, fakeStripe);
    const s0 = await ctx.settings.get(); // settings persist in the database across boots, so set the Stripe price where it is read
    await ctx.settings.update({ ...s0, plans: { ...s0.plans, pro: { ...s0.plans.pro, stripePriceId: 'price_pro', razorpayPlanId: 'plan_pro_rz' }, business: { ...s0.plans.business, stripePriceId: undefined, razorpayPlanId: 'plan_biz_rz' } } });
    expect((await request(ctx.app).get('/api/config')).body.data.features.billingProviders).toEqual(['stripe', 'razorpay']);
    const plans = (await request(ctx.app).get('/api/plans')).body.data as { id: string; providers: string[] }[];
    expect(plans.find((p) => p.id === 'pro')!.providers).toEqual(['stripe', 'razorpay']);
    expect(plans.find((p) => p.id === 'business')!.providers).toEqual(['razorpay']); // no Stripe price mapped for Business
    const u = await signup();
    expect((await api(u).post('/api/billing/checkout', { plan: 'pro' })).body.data.url).toBe('https://stripe.test/c');
    expect(rz.seen).toEqual([]);
    expect((await api(u).post('/api/billing/checkout', { plan: 'pro', provider: 'razorpay' })).body.data.url).toMatch(/rzp\.test/);
    expect((await api(u).post('/api/billing/checkout', { plan: 'business', provider: 'stripe' })).body.error.code).toBe('plan_unavailable');
    expect((await api(u).post('/api/billing/checkout', { plan: 'pro', provider: 'paypal' })).status).toBe(400);
  });
});
