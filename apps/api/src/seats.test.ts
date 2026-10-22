import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, MemberModel, TeamModel, UserModel, InviteModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import type { StripeClient } from './modules/billing/service.js';
import { seatLimits } from './modules/billing/seats.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const realStripe = new Stripe('sk_test_dummy');

/** What the fake Stripe saw and how it should behave. The shapes of what we send are also checked by the compiler against Stripe's own types. */
const stripe = {
  sessions: [] as Record<string, unknown>[], updates: [] as { id: string; params: Record<string, unknown> }[],
  quantity: 3, fail: null as null | 'card' | 'other', forceQuantity: undefined as number | undefined,
};
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_seat' }) },
  checkout: { sessions: { create: async (p: Record<string, unknown>) => { stripe.sessions.push(p); return { url: 'https://stripe.test/c' }; } } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/p' }) } },
  subscriptions: {
    cancel: async () => undefined,
    retrieve: async (id: string) => ({ id, items: { data: [{ id: 'si_1', quantity: stripe.quantity }] } }),
    update: async (id: string, params: { items: { id: string; quantity: number }[] }) => {
      stripe.updates.push({ id, params: params as never });
      if (stripe.fail === 'card') throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError' });
      if (stripe.fail === 'other') throw new Error('stripe is having a bad day');
      stripe.quantity = stripe.forceQuantity ?? params.items[0]!.quantity;
      return { id, items: { data: [{ id: 'si_1', quantity: stripe.quantity }] } };
    },
  },
  webhooks: realStripe.webhooks,
} as unknown as StripeClient;

const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
interface U { email: string; token: string; id: string }
async function signup(): Promise<U> {
  const email = `s${n++}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: `P${n}` });
  expect(r.status).toBe(201);
  await UserModel.updateOne({ email }, { emailVerifiedAt: new Date() });
  return { email, token: r.body.data.accessToken, id: r.body.data.user.id };
}
const api = (u: U) => ({
  get: (p: string) => request(ctx.app).get(p).set(bearer(u.token)),
  post: (p: string, b: object = {}) => request(ctx.app).post(p).set(bearer(u.token)).send(b),
});
const view = async (u: U) => (await api(u).get('/api/teams/mine')).body.data;

let evt = 0;
const sub = (teamId: string, o: { quantity?: number; status?: string; created?: number; type?: string; price?: string } = {}) => {
  const created = o.created;
  const body = { id: `evt_seat_${evt++}`, object: 'event', type: o.type ?? 'customer.subscription.updated', ...(created !== undefined ? { created } : {}), data: { object: {
    id: 'sub_seat', customer: 'cus_seat', status: o.status ?? 'active', metadata: { teamId }, cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30, items: { data: [{ id: 'si_1', quantity: o.quantity ?? 3, price: { id: o.price ?? 'price_pro' } }] },
  } } };
  const payload = JSON.stringify(body);
  return request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' })).send(payload);
};

/** A team with `members` further members (written directly), optionally subscribed with a quantity through a real signed webhook. */
async function team(o: { members?: number; invites?: number; quantity?: number } = {}) {
  const owner = await signup();
  const t = await api(owner).post('/api/teams', { name: 'Acme Design' });
  expect(t.status).toBe(201);
  const teamId = t.body.data.id as string;
  const people: U[] = [];
  for (let i = 0; i < (o.members ?? 0); i++) { const m = await signup(); await MemberModel.create({ teamId, userId: m.id, role: 'member' }); people.push(m); }
  for (let i = 0; i < (o.invites ?? 0); i++) await InviteModel.create({ teamId, email: `inv${n++}@example.com`, role: 'member', tokenHash: `i${n++}`.padEnd(64, 'x'), invitedBy: owner.id, expiresAt: new Date(Date.now() + 864e5) });
  if (o.quantity !== undefined) { expect((await sub(teamId, { quantity: o.quantity })).status).toBe(200); stripe.quantity = o.quantity; }
  return { owner, teamId, people };
}
const team$ = (teamId: string) => TeamModel.findById(teamId).lean<{ plan: string; billing?: { seats?: number; eventAt?: number } }>();
const checkout = (u: U, body: object) => api(u).post('/api/billing/team/checkout', body);
const setSeats = (u: U, seats: unknown) => api(u).post('/api/billing/team/seats', { seats });

async function boot(extra: Record<string, string>) {
  storage = await mkdtemp(join(tmpdir(), 'seats-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_biz', STRIPE_WEBHOOK_SECRET: 'whsec_test', TEAM_SEATS_PRO: '3', TEAM_SEATS_BUSINESS: '10', ...extra,
  });
  ctx = await createApp({ env, mailer, stripe: fakeStripe });
}

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await boot({ TEAM_BILLING: 'per_seat', TEAM_MIN_SEATS: '2', TEAM_MAX_SEATS: '20' }); }, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });
beforeEach(() => { stripe.sessions.length = 0; stripe.updates.length = 0; stripe.fail = null; stripe.forceQuantity = undefined; stripe.quantity = 3; });

describe('the seat limits', () => {
  it('are never below the people already there or the minimum, never above the maximum, and never contradictory', () => {
    const e = { TEAM_MIN_SEATS: 2, TEAM_MAX_SEATS: 20 };
    expect(seatLimits(e)).toEqual({ min: 2, max: 20 });
    expect(seatLimits(e, 1)).toEqual({ min: 2, max: 20 });
    expect(seatLimits(e, 7)).toEqual({ min: 7, max: 20 });
    expect(seatLimits(e, 50)).toEqual({ min: 20, max: 20 }); // a team larger than the maximum is not asked for more than the maximum
    expect(seatLimits({ TEAM_MIN_SEATS: 30, TEAM_MAX_SEATS: 10 })).toEqual({ min: 10, max: 10 }); // misconfigured: the maximum wins
    expect(seatLimits({ TEAM_MIN_SEATS: 0, TEAM_MAX_SEATS: 0 })).toEqual({ min: 1, max: 1 });
  });
});

describe('subscribing a team per seat', () => {
  it('charges the plan\'s price once per seat bought, and lets the payer adjust within the same limits', async () => {
    const t = await team({ members: 2, invites: 1 }); // 4 people already: the owner, two members, one invitation
    const r = await checkout(t.owner, { plan: 'pro', seats: 5 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(stripe.sessions[0]).toMatchObject({
      mode: 'subscription', client_reference_id: `team:${t.teamId}`, subscription_data: { metadata: { teamId: t.teamId, plan: 'pro' } },
      line_items: [{ price: 'price_pro', quantity: 5, adjustable_quantity: { enabled: true, minimum: 4, maximum: 20 } }],
    });
    // without a number it asks for what the team needs (at least the minimum)
    await checkout(t.owner, { plan: 'pro' });
    expect((stripe.sessions[1]!.line_items as { quantity: number }[])[0]!.quantity).toBe(4);
    const small = await team();
    await checkout(small.owner, { plan: 'business' });
    expect((stripe.sessions[2]!.line_items as { quantity: number; price: string }[])[0]).toMatchObject({ price: 'price_biz', quantity: 2 });
  });

  it('refuses a seat count that is not a whole number, is below the minimum, below the people already there, or above the maximum', async () => {
    const t = await team({ members: 2, invites: 1 });
    for (const [bad, why] of [[1, /from 4 to 20.*already has 4 people/], [3, /from 4 to 20/], [21, /from 4 to 20/]] as const) {
      const r = await checkout(t.owner, { plan: 'pro', seats: bad });
      expect(r.status, String(bad)).toBe(400); expect(r.body.error.code).toBe('invalid_seats'); expect(r.body.error.message).toMatch(why);
    }
    for (const bad of [2.5, '5', null, {}]) expect((await checkout(t.owner, { plan: 'pro', seats: bad })).status, JSON.stringify(bad)).toBe(400);
    expect(stripe.sessions).toHaveLength(0); // nothing reached Stripe
  });

  it('is for the owner only', async () => {
    const t = await team({ members: 1 });
    expect((await checkout(t.people[0]!, { plan: 'pro', seats: 3 })).status).toBe(403);
    expect((await setSeats(t.people[0]!, 3)).status).toBe(403);
    expect((await request(ctx.app).post('/api/billing/team/seats').send({ seats: 3 })).status).toBe(401);
    expect(stripe.sessions).toHaveLength(0); expect(stripe.updates).toHaveLength(0);
  });
});

describe('seats follow what Stripe says the team pays for', () => {
  it('the subscription quantity becomes the team\'s seats, and invitations use exactly that many', async () => {
    const t = await team({ quantity: 4 });
    expect(await view(t.owner)).toMatchObject({ plan: 'pro', seats: 4, seatsUsed: 1, seatBilling: { min: 2, max: 20 } });
    for (let i = 0; i < 3; i++) expect((await api(t.owner).post('/api/teams/mine/invites', { email: `x${n++}@example.com` })).status).toBe(201);
    const full = await api(t.owner).post('/api/teams/mine/invites', { email: `x${n++}@example.com` });
    expect(full.status).toBe(409); expect(full.body.error.code).toBe('no_seats');
    // buying more opens more
    expect((await sub(t.teamId, { quantity: 6 })).status).toBe(200);
    expect((await view(t.owner)).seats).toBe(6);
    expect((await api(t.owner).post('/api/teams/mine/invites', { email: `x${n++}@example.com` })).status).toBe(201);
  });

  it('a team that shrinks below its people keeps them all and simply cannot add more', async () => {
    const t = await team({ members: 4, quantity: 6 });
    expect((await sub(t.teamId, { quantity: 3 })).status).toBe(200);
    const v = await view(t.owner);
    expect(v).toMatchObject({ seats: 3, seatsUsed: 5 });
    expect(v.members).toHaveLength(5);
    expect(v.seatBilling.min).toBe(5); // and cannot choose fewer than it has
    const r = await api(t.owner).post('/api/teams/mine/invites', { email: `x${n++}@example.com` });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('no_seats');
  });

  it('only the owner sees the seat choices; members see the seat count', async () => {
    const t = await team({ members: 1, quantity: 5 });
    expect((await view(t.people[0]!)).seatBilling).toBeUndefined();
    expect((await view(t.people[0]!)).seats).toBe(5);
  });

  it('an older event arriving late cannot undo a newer one; an equal timestamp, or none at all, still applies', async () => {
    const t = await team();
    const seats = async () => (await view(t.owner)).seats;
    expect((await sub(t.teamId, { quantity: 8, created: 2000 })).status).toBe(200); expect(await seats()).toBe(8);
    expect((await sub(t.teamId, { quantity: 4, created: 1000 })).status).toBe(200); expect(await seats()).toBe(8); // stale: ignored
    expect((await sub(t.teamId, { quantity: 5, created: 3000 })).status).toBe(200); expect(await seats()).toBe(5);
    expect((await sub(t.teamId, { quantity: 7, created: 3000 })).status).toBe(200); expect(await seats()).toBe(7); // same second: applied
    expect((await sub(t.teamId, { quantity: 9 })).status).toBe(200); expect(await seats()).toBe(9); // no timestamp: applied
    // and the same holds for the subscription ending: a stale "deleted" does not cancel a live team
    expect((await sub(t.teamId, { type: 'customer.subscription.deleted', status: 'canceled', created: 500 })).status).toBe(200);
    expect((await team$(t.teamId))!.plan).toBe('pro');
  });

  it('when the subscription ends the team is back to one seat, and keeps its people', async () => {
    const t = await team({ members: 2, quantity: 6 });
    expect((await sub(t.teamId, { type: 'customer.subscription.deleted', status: 'canceled' })).status).toBe(200);
    expect(await view(t.owner)).toMatchObject({ plan: 'free', seats: 1, seatsUsed: 3 });
  });

  it('a paid team with no recorded quantity (it subscribed before per-seat billing) keeps the plan\'s seats instead of dropping to one', async () => {
    const t = await team();
    await TeamModel.updateOne({ _id: t.teamId }, { plan: 'pro', $unset: { 'billing.seats': 1 } });
    expect((await view(t.owner)).seats).toBe(3); // TEAM_SEATS_PRO
  });
});

describe('changing the number of seats', () => {
  it('asks Stripe to prorate and refuse an unpaid increase, and shows the new count at once', async () => {
    const t = await team({ members: 1, quantity: 3 });
    const r = await setSeats(t.owner, 6);
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.data.seats).toBe(6);
    expect(stripe.updates).toEqual([{ id: 'sub_seat', params: { items: [{ id: 'si_1', quantity: 6 }], proration_behavior: 'create_prorations', payment_behavior: 'error_if_incomplete' } }]);
    expect((await view(t.owner)).seats).toBe(6);
    // the (older) webhook for the previous quantity cannot roll it back; the matching one is harmless
    expect((await sub(t.teamId, { quantity: 3, created: Math.floor(Date.now() / 1000) - 60 })).status).toBe(200);
    expect((await view(t.owner)).seats).toBe(6);
    expect((await sub(t.teamId, { quantity: 6, created: Math.floor(Date.now() / 1000) + 1 })).status).toBe(200);
    expect((await view(t.owner)).seats).toBe(6);
    // and it can come back down, to the number of people it has but no lower
    stripe.updates.length = 0;
    expect((await setSeats(t.owner, 2)).body.data.seats).toBe(2);
    const low = await setSeats(t.owner, 1);
    expect(low.status).toBe(400); expect(low.body.error.code).toBe('invalid_seats');
    expect(stripe.updates).toHaveLength(1);
  });

  it('never goes below the members plus pending invitations, nor outside the limits, and does not call Stripe for a refusal', async () => {
    const t = await team({ members: 2, invites: 2, quantity: 6 }); // 5 people
    for (const [bad, ok] of [[4, false], [5, true]] as const) {
      const r = await setSeats(t.owner, bad);
      expect(r.status, String(bad)).toBe(ok ? 200 : 400);
    }
    expect(stripe.updates).toHaveLength(1);
    stripe.updates.length = 0;
    for (const bad of [21, 0, 2.5, -3]) expect((await setSeats(t.owner, bad)).status, String(bad)).toBe(400);
    expect((await setSeats(t.owner, '5')).status).toBe(400);
    expect(stripe.updates).toHaveLength(0);
  });

  it('does nothing (and does not call Stripe to update) when the number is already right', async () => {
    const t = await team({ quantity: 4 });
    const r = await setSeats(t.owner, 4);
    expect(r.status).toBe(200); expect(r.body.data.seats).toBe(4);
    expect(stripe.updates).toHaveLength(0);
  });

  it('keeps the old seat count and says why when the card is declined, or Stripe fails', async () => {
    const t = await team({ members: 1, quantity: 3 });
    stripe.fail = 'card';
    const declined = await setSeats(t.owner, 8);
    expect(declined.status).toBe(402); expect(declined.body.error.code).toBe('payment_failed'); expect(declined.body.error.message).toMatch(/card on file was declined/);
    stripe.fail = 'other';
    const broken = await setSeats(t.owner, 8);
    expect(broken.status).toBe(502); expect(broken.body.error.code).toBe('billing_error');
    expect(JSON.stringify(broken.body)).not.toContain('bad day'); // Stripe's wording is not shown to users
    expect((await view(t.owner)).seats).toBe(3);
    expect((await team$(t.teamId))!.billing!.seats).toBe(3);
  });

  it('records what Stripe actually set, if that differs from what was asked', async () => {
    const t = await team({ members: 1, quantity: 3 });
    stripe.forceQuantity = 7;
    expect((await setSeats(t.owner, 6)).body.data.seats).toBe(7);
    expect((await view(t.owner)).seats).toBe(7);
  });

  it('needs an active subscription', async () => {
    const free = await team();
    const none = await setSeats(free.owner, 3);
    expect(none.status).toBe(409); expect(none.body.error.code).toBe('no_subscription');
    const late = await team({ quantity: 3 });
    expect((await sub(late.teamId, { status: 'past_due', quantity: 3 })).status).toBe(200); // past due: sort out the payment first
    expect((await setSeats(late.owner, 5)).body.error.code).toBe('no_subscription');
    expect(stripe.updates).toHaveLength(0);
  });
});

describe('a server that charges teams a flat price', () => {
  beforeAll(async () => { await ctx.close?.(); await rm(storage, { recursive: true, force: true }); await boot({ TEAM_BILLING: 'flat' }); });

  it('is unchanged: no seat choices, seats from the plan, and asking for per-seat things is refused clearly', async () => {
    const subscribed = await team({ quantity: 9 }); // a quantity from Stripe means nothing here
    expect(await view(subscribed.owner)).toMatchObject({ plan: 'pro', seats: 3 }); // TEAM_SEATS_PRO
    expect((await view(subscribed.owner)).seatBilling).toBeUndefined();
    const t = await team();
    const c = await checkout(t.owner, { plan: 'pro', seats: 5 });
    expect(c.status).toBe(400); expect(c.body.error.code).toBe('not_per_seat');
    expect((await checkout(t.owner, { plan: 'pro' })).status).toBe(200);
    expect((stripe.sessions[0]!.line_items as { quantity: number }[])[0]).toEqual({ price: 'price_pro', quantity: 1 });
    const s = await setSeats(t.owner, 5);
    expect(s.status).toBe(409); expect(s.body.error.code).toBe('not_per_seat');
    expect((await request(ctx.app).get('/api/config')).body.data.features.teamBilling).toBe('flat');
  });
});
