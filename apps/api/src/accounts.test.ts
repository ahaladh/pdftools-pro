import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, SessionModel, SettingModel, UserModel, AuditModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { BillingService, type StripeClient } from './modules/billing/service.js';
import { JobService } from './modules/jobs/service.js';
import { MongoJobStore } from './modules/jobs/mongo-store.js';
import { SettingsService, MemorySettingsStore } from './modules/settings/service.js';
import { defaultSettings } from './modules/settings/defaults.js';
import { pino } from 'pino';
import { listRoutes } from './route-list.js';
import { SignJWT } from 'jose';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const calls = { customers: [] as unknown[], sessions: [] as Record<string, unknown>[], cancelled: [] as string[] };
const realStripe = new Stripe('sk_test_dummy');
const fakeStripe = {
  customers: { create: async (p: unknown) => { calls.customers.push(p); return { id: 'cus_1' }; } },
  checkout: { sessions: { create: async (p: Record<string, unknown>) => { calls.sessions.push(p); return { url: 'https://stripe.test/c/1' }; } } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://stripe.test/p/1' }) } },
  subscriptions: { cancel: async (id: string) => { calls.cancelled.push(id); } },
  webhooks: realStripe.webhooks,
} as unknown as StripeClient;

const PW = 'correct horse battery';
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([200, 200]); return Buffer.from(await d.save()); };
const cookieOf = (res: request.Response, name: string) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${name}=`));
const tokenFromCookie = (c: string) => c.split(';')[0]!.split('=')[1]!;
let n = 0;
async function signup(email = `user${n++}@example.com`) {
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'Test' });
  expect(r.status).toBe(201);
  return { email, token: r.body.data.accessToken as string, id: r.body.data.user.id as string, refresh: tokenFromCookie(cookieOf(r, 'pt_refresh')!) };
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
async function waitDone(token: string | null, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const rq = request(ctx.app).get(`/api/jobs/${jobId}`);
    const r = token ? await rq.set(auth(token)) : await rq;
    if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data;
    await new Promise((x) => setTimeout(x, 30));
  }
  throw new Error('timeout');
}
let admin: { token: string; id: string };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'acct-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), MAX_FILE_MB: '1', MAX_PAGES: '10', RETENTION_MINUTES: '5',
    DAILY_OPS_GUEST: '1', DAILY_OPS_FREE: '3', RATE_LIMIT_ENABLED: 'false', MAX_CONCURRENT_JOBS_PER_USER: '2',
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_BUSINESS: 'price_biz', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  });
  ctx = await createApp({ env, mailer, stripe: fakeStripe });
  const r = await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' });
  admin = { token: r.body.data.accessToken, id: r.body.data.user.id };
}, 120_000);
afterAll(async () => { await disconnectDb(); await mongo.stop(); await rm(storage, { recursive: true, force: true }); });

describe('registration and login', () => {
  it('registers, sets a hardened refresh cookie and never returns the hash', async () => {
    const r = await request(ctx.app).post('/api/auth/register').send({ email: '  New@Example.com ', password: PW, name: 'N' });
    expect(r.status).toBe(201);
    expect(r.body.data.user.email).toBe('new@example.com');
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|scrypt/);
    const c = cookieOf(r, 'pt_refresh')!;
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Strict/i); expect(c).toMatch(/Path=\/api\/auth/);
  });
  it('stores a salted scrypt hash, not the password', async () => {
    const u = await UserModel.findOne({ email: 'new@example.com' });
    expect(u!.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(u!.passwordHash).not.toContain(PW);
  });
  it('rejects duplicates and weak passwords', async () => {
    expect((await request(ctx.app).post('/api/auth/register').send({ email: 'new@example.com', password: PW })).status).toBe(409);
    expect((await request(ctx.app).post('/api/auth/register').send({ email: 'x@example.com', password: 'short' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/register').send({ email: 'not-an-email', password: PW })).status).toBe(400);
  });
  it('gives the same error for unknown user and wrong password', async () => {
    const a = await request(ctx.app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PW });
    const b = await request(ctx.app).post('/api/auth/login').send({ email: 'new@example.com', password: 'wrong-password-1' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });
  it('locks the account after repeated failures, even for the right password', async () => {
    const { email } = await signup();
    for (let i = 0; i < 5; i++) await request(ctx.app).post('/api/auth/login').send({ email, password: 'wrong-password-1' });
    const r = await request(ctx.app).post('/api/auth/login').send({ email, password: PW });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('account_locked');
  });
});

describe('sessions and tokens', () => {
  it('protects /api/me and rejects garbage or tampered bearer tokens', async () => {
    const u = await signup();
    expect((await request(ctx.app).get('/api/me')).status).toBe(401);
    expect((await request(ctx.app).get('/api/me').set(auth('garbage'))).status).toBe(401);
    expect((await request(ctx.app).get('/api/me').set(auth(u.token.slice(0, -3) + 'abc'))).status).toBe(401);
    const ok = await request(ctx.app).get('/api/me').set(auth(u.token));
    expect(ok.status).toBe(200); expect(ok.body.data.email).toBe(u.email);
  });
  it('requires the CSRF header on refresh and logout', async () => {
    const u = await signup();
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(403);
    expect((await request(ctx.app).post('/api/auth/logout').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(403);
  });
  it('rotates refresh tokens and revokes the whole family when an old one is replayed', async () => {
    const u = await signup();
    const h = { 'X-PDFTools-CSRF': '1' };
    const r1 = await request(ctx.app).post('/api/auth/refresh').set(h).set('Cookie', `pt_refresh=${u.refresh}`);
    expect(r1.status).toBe(200);
    const fresh = tokenFromCookie(cookieOf(r1, 'pt_refresh')!);
    expect(fresh).not.toBe(u.refresh);
    // replaying the old token = theft signal
    expect((await request(ctx.app).post('/api/auth/refresh').set(h).set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
    // ...which also kills the legitimately rotated token
    expect((await request(ctx.app).post('/api/auth/refresh').set(h).set('Cookie', `pt_refresh=${fresh}`)).status).toBe(401);
  });
  it('allows only one of two simultaneous refreshes with the same token', async () => {
    const u = await signup();
    const h = { 'X-PDFTools-CSRF': '1' };
    const [a, b] = await Promise.all([1, 2].map(() => request(ctx.app).post('/api/auth/refresh').set(h).set('Cookie', `pt_refresh=${u.refresh}`)));
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });
  it('logout invalidates the refresh token', async () => {
    const u = await signup();
    const h = { 'X-PDFTools-CSRF': '1' };
    expect((await request(ctx.app).post('/api/auth/logout').set(h).set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/refresh').set(h).set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
  });
  it('only stores a hash of the refresh token', async () => {
    const u = await signup();
    const s = await SessionModel.findOne({ userId: u.id });
    expect(s!.tokenHash).not.toBe(u.refresh);
    expect(s!.tokenHash).toHaveLength(64);
  });
});

describe('password reset and change', () => {
  it('does not reveal whether an email exists, and sends a single-use link', async () => {
    const u = await signup();
    mailer.sent.length = 0;
    const unknown = await request(ctx.app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    const known = await request(ctx.app).post('/api/auth/forgot-password').send({ email: u.email });
    expect(unknown.body).toEqual(known.body);
    expect(mailer.sent).toHaveLength(1);
    const token = /token=([\w-]+)/.exec(mailer.sent[0]!.text)![1]!;
    const stored = await UserModel.findOne({ email: u.email });
    expect(stored!.resetTokenHash).not.toContain(token); // only the hash is stored
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token, password: 'a-brand-new-password' })).status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token, password: 'another-new-password' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: PW })).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: 'a-brand-new-password' })).status).toBe(200);
    // old sessions were revoked
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
  });
  it('rejects expired and invalid reset tokens', async () => {
    const u = await signup();
    await request(ctx.app).post('/api/auth/forgot-password').send({ email: u.email });
    await UserModel.updateOne({ email: u.email }, { resetTokenExpires: new Date(Date.now() - 1000) });
    const token = /token=([\w-]+)/.exec(mailer.sent.at(-1)!.text)![1]!;
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token, password: 'a-brand-new-password' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token: 'x'.repeat(30), password: 'a-brand-new-password' })).status).toBe(400);
  });
  it('change-password verifies the current password and rotates sessions', async () => {
    const u = await signup();
    expect((await request(ctx.app).post('/api/me/password').set(auth(u.token)).send({ currentPassword: 'wrong-password-1', newPassword: 'another-new-password' })).status).toBe(403);
    const r = await request(ctx.app).post('/api/me/password').set(auth(u.token)).send({ currentPassword: PW, newPassword: 'another-new-password' });
    expect(r.status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
    expect(cookieOf(r, 'pt_refresh')).toBeTruthy();
  });
});

describe('entitlements and usage', () => {
  it('blocks premium tools for guests and free users with a clear code, allows paid plans', async () => {
    const u = await signup();
    const a = await pdf(1), b = await pdf(1);
    const guest = await request(ctx.app).post('/api/pdf/compare').attach('files', a, 'a.pdf').attach('files', b, 'b.pdf');
    expect(guest.status).toBe(403); expect(guest.body.error.code).toBe('upgrade_required');
    const free = await request(ctx.app).post('/api/pdf/compare').set(auth(u.token)).attach('files', a, 'a.pdf').attach('files', b, 'b.pdf');
    expect(free.status).toBe(403);
    await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ plan: 'pro' });
    const pro = await request(ctx.app).post('/api/pdf/compare').set(auth(u.token)).attach('files', a, 'a.pdf').attach('files', b, 'b.pdf');
    expect(pro.status).toBe(202);
    expect((await waitDone(u.token, pro.body.data.jobId)).state).toBe('completed');
  });
  it('enforces the daily quota per account and reports usage', async () => {
    const u = await signup();
    for (let i = 0; i < 3; i++) {
      const r = await request(ctx.app).post('/api/pdf/rotate').set(auth(u.token)).attach('files', await pdf(1), 'a.pdf');
      expect(r.status).toBe(202);
      expect((await waitDone(u.token, r.body.data.jobId)).state).toBe('completed');
    }
    const over = await request(ctx.app).post('/api/pdf/rotate').set(auth(u.token)).attach('files', await pdf(1), 'a.pdf');
    expect(over.status).toBe(429); expect(over.body.error.code).toBe('quota_exceeded');
    const usage = await request(ctx.app).get('/api/me/usage').set(auth(u.token));
    expect(usage.body.data.today).toEqual({ ops: 3, limit: 3 });
    expect(usage.body.data.last30Days).toHaveLength(30);
  });
  it('does not count failed jobs against the quota', async () => {
    const u = await signup();
    for (let i = 0; i < 4; i++) {
      const r = await request(ctx.app).post('/api/pdf/rotate').set(auth(u.token)).attach('files', Buffer.from('%PDF-1.4\njunk'), 'bad.pdf');
      expect(r.status).toBe(202);
      expect((await waitDone(u.token, r.body.data.jobId)).state).toBe('failed');
    }
    expect((await request(ctx.app).get('/api/me/usage').set(auth(u.token))).body.data.today.ops).toBe(0);
  });
  it('applies guest quota by IP so clearing cookies does not reset it', async () => {
    const first = await request(ctx.app).post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    expect(first.status).toBe(202);
    await waitDone(null, first.body.data.jobId).catch(() => undefined);
  });
  it('...second guest identity from the same IP is blocked', async () => {
    // new cookie-less request, same IP (supertest uses loopback)
    for (let i = 0; i < 50; i++) { if ((await ctx.usage.ops('ip:::ffff:127.0.0.1')) + (await ctx.usage.ops('ip:127.0.0.1')) + (await ctx.usage.ops('ip:::1')) > 0) break; await new Promise((x) => setTimeout(x, 40)); }
    const r = await request(ctx.app).post('/api/pdf/rotate').attach('files', await pdf(1), 'a.pdf');
    expect(r.status).toBe(429); expect(r.body.error.code).toBe('quota_exceeded');
  });
  it('uses plan-based upload size limits', async () => {
    const free = await signup();
    const pro = await signup();
    await request(ctx.app).patch(`/api/admin/users/${pro.id}`).set(auth(admin.token)).send({ plan: 'pro' });
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1.5 * 1024 * 1024)]);
    expect((await request(ctx.app).post('/api/pdf/rotate').set(auth(free.token)).attach('files', big, 'big.pdf')).status).toBe(413);
    expect((await request(ctx.app).post('/api/pdf/rotate').set(auth(pro.token)).attach('files', big, 'big.pdf')).status).toBe(202);
  });
  it('keeps job history private to the owner', async () => {
    const a = await signup(), b = await signup();
    const r = await request(ctx.app).post('/api/pdf/rotate').set(auth(a.token)).attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(a.token, r.body.data.jobId);
    expect((await request(ctx.app).get(`/api/jobs/${job.id}`).set(auth(b.token))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/jobs/${job.id}`)).status).toBe(404);
    expect((await request(ctx.app).get(job.result.downloadUrl).set(auth(b.token))).status).toBe(404);
    expect(job.error).toBeUndefined(); // a completed job must not carry an empty error object
    const hist = await request(ctx.app).get('/api/me/jobs').set(auth(a.token));
    expect(hist.body.data.map((j: { id: string }) => j.id)).toContain(job.id);
    expect((await request(ctx.app).get('/api/me/jobs').set(auth(b.token))).body.data).toHaveLength(0);
    expect((await request(ctx.app).get(job.result.downloadUrl).set(auth(a.token))).status).toBe(200);
  });
  it('runs higher-priority plans first when the queue is busy', async () => {
    const lowU = await signup(), highU = await signup();
    await request(ctx.app).patch(`/api/admin/users/${highU.id}`).set(auth(admin.token)).send({ plan: 'business' });
    const saved = ctx.env.WORKER_CONCURRENCY;
    ctx.env.WORKER_CONCURRENCY = 0; // hold the queue
    const low = await request(ctx.app).post('/api/pdf/rotate').set(auth(lowU.token)).attach('files', await pdf(1), 'a.pdf');
    const high = await request(ctx.app).post('/api/pdf/rotate').set(auth(highU.token)).attach('files', await pdf(1), 'a.pdf');
    ctx.env.WORKER_CONCURRENCY = 1;
    const blocker = await request(ctx.app).post('/api/pdf/rotate').set(auth(highU.token)).attach('files', await pdf(1), 'a.pdf'); // triggers a pump
    const started: string[] = [];
    for (let i = 0; i < 4000 && started.length < 2; i++) {
      for (const [name, id] of [['low', low.body.data.jobId], ['high', high.body.data.jobId]] as const) {
        const j = await ctx.jobs.store.get(id);
        if (j && j.state !== 'queued' && !started.includes(name)) started.push(name);
      }
      await new Promise((x) => setTimeout(x, 1));
    }
    ctx.env.WORKER_CONCURRENCY = saved;
    void blocker;
    expect(started[0]).toBe('high');
  });
});

describe('admin authorization and operations', () => {
  const endpoints = ['/api/admin/dashboard', '/api/admin/users', '/api/admin/jobs', '/api/admin/usage', '/api/admin/settings', '/api/admin/audit'];
  it('rejects guests (401) and regular users (403) on every admin endpoint', async () => {
    const u = await signup();
    for (const e of endpoints) {
      expect((await request(ctx.app).get(e)).status).toBe(401);
      expect((await request(ctx.app).get(e).set(auth(u.token))).status).toBe(403);
    }
    expect((await request(ctx.app).put('/api/admin/settings').set(auth(u.token)).send({})).status).toBe(403);
    expect((await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(u.token)).send({ role: 'admin' })).status).toBe(403);
  });
  it('cannot be bypassed by claiming a role in the request', async () => {
    const u = await signup();
    expect((await request(ctx.app).get('/api/admin/users').set(auth(u.token)).set('X-Role', 'admin').query({ role: 'admin' })).status).toBe(403);
  });
  it('returns dashboard metrics', async () => {
    const r = await request(ctx.app).get('/api/admin/dashboard').set(auth(admin.token));
    expect(r.status).toBe(200);
    expect(r.body.data.users.total).toBeGreaterThan(3);
    expect(r.body.data).toMatchObject({ queue: { waiting: expect.any(Number), active: expect.any(Number) }, storage: { bytes: expect.any(Number) }, system: { cpus: expect.any(Number) } });
    expect(r.body.data.jobs.byState).toBeTypeOf('object');
  });
  it('lists, searches and paginates users', async () => {
    await signup('findme-unique@example.com');
    const r = await request(ctx.app).get('/api/admin/users').set(auth(admin.token)).query({ q: 'findme-unique' });
    expect(r.body.data.total).toBe(1);
    const p = await request(ctx.app).get('/api/admin/users').set(auth(admin.token)).query({ pageSize: 2, page: 2 });
    expect(p.body.data.rows.length).toBeLessThanOrEqual(2);
    expect((await request(ctx.app).get('/api/admin/users').set(auth(admin.token)).query({ q: '.*' })).body.data.total).toBe(0); // regex is escaped
    expect((await request(ctx.app).get('/api/admin/users').set(auth(admin.token)).query({ pageSize: 1000 })).status).toBe(400);
  });
  it('changes plans/roles with an audit trail, and blocks self-lockout', async () => {
    const u = await signup();
    const r = await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ plan: 'business' });
    expect(r.body.data.plan).toBe('business');
    expect(await AuditModel.countDocuments({ action: 'admin.user_updated', target: `u:${u.id}` })).toBe(1);
    expect((await request(ctx.app).patch(`/api/admin/users/${admin.id}`).set(auth(admin.token)).send({ role: 'user' })).status).toBe(400);
    expect((await request(ctx.app).patch(`/api/admin/users/${admin.id}`).set(auth(admin.token)).send({ status: 'disabled' })).status).toBe(400);
    expect((await request(ctx.app).patch(`/api/admin/users/zzz`).set(auth(admin.token)).send({ plan: 'pro' })).status).toBe(404);
    expect((await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ plan: 'platinum' })).status).toBe(400);
    expect((await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({})).status).toBe(400);
  });
  it('disabling a user revokes their access immediately', async () => {
    const u = await signup();
    expect((await request(ctx.app).get('/api/me').set(auth(u.token))).status).toBe(200);
    await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ status: 'disabled' });
    expect((await request(ctx.app).get('/api/me').set(auth(u.token))).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: PW })).status).toBe(403);
  });
  it('role is read from the database, not the token: demoting takes effect at once', async () => {
    const u = await signup();
    await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ role: 'admin' });
    const login = await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: PW });
    const t = login.body.data.accessToken;
    expect((await request(ctx.app).get('/api/admin/users').set(auth(t))).status).toBe(200);
    await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(auth(admin.token)).send({ role: 'user' });
    expect((await request(ctx.app).get('/api/admin/users').set(auth(t))).status).toBe(403);
  });
  it('lists jobs without leaking paths, filenames or options', async () => {
    const r = await request(ctx.app).get('/api/admin/jobs').set(auth(admin.token)).query({ pageSize: 50 });
    expect(r.status).toBe(200);
    expect(r.body.data.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/\/tmp|inputs|options|\.pdf/);
  });
  it('validates and applies settings: tool toggles and maintenance mode', async () => {
    const cur = (await request(ctx.app).get('/api/admin/settings').set(auth(admin.token))).body.data;
    const bad = structuredClone(cur); bad.plans.pro.maxFileMB = -5;
    expect((await request(ctx.app).put('/api/admin/settings').set(auth(admin.token)).send(bad)).status).toBe(400);
    const next = structuredClone(cur); next.disabledTools = ['rotate'];
    expect((await request(ctx.app).put('/api/admin/settings').set(auth(admin.token)).send(next)).status).toBe(200);
    const blocked = await request(ctx.app).post('/api/pdf/rotate').set(auth(admin.token)).attach('files', await pdf(1), 'a.pdf');
    expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe('tool_disabled');
    expect((await request(ctx.app).get('/api/tools')).body.data.some((t: { id: string }) => t.id === 'rotate')).toBe(false);
    next.disabledTools = []; next.maintenance = true;
    await request(ctx.app).put('/api/admin/settings').set(auth(admin.token)).send(next);
    expect((await request(ctx.app).post('/api/pdf/merge').set(auth(admin.token)).attach('files', await pdf(1), 'a.pdf').attach('files', await pdf(1), 'b.pdf')).status).toBe(503);
    expect((await request(ctx.app).get('/api/admin/dashboard').set(auth(admin.token))).status).toBe(200); // admin stays reachable
    next.maintenance = false;
    await request(ctx.app).put('/api/admin/settings').set(auth(admin.token)).send(next);
    expect(await AuditModel.countDocuments({ action: 'admin.settings_updated' })).toBeGreaterThanOrEqual(3);
  });
  it('exposes the audit log to admins with filtering', async () => {
    const r = await request(ctx.app).get('/api/admin/audit').set(auth(admin.token)).query({ action: 'auth.register' });
    expect(r.body.data.rows.length).toBeGreaterThan(0);
    expect(r.body.data.rows.every((x: { action: string }) => x.action === 'auth.register')).toBe(true);
  });
  it('falls back to defaults if the stored settings document is corrupt', async () => {
    const s = new SettingsService({ load: async () => ({ plans: 'nope' }), save: async () => undefined }, defaultSettings(ctx.env), 0);
    expect((await s.get()).plans.pro.name).toBe('Pro');
    void SettingModel;
  });
});

describe('plans endpoint', () => {
  it('is public, hides price ids, and marks purchasable plans', async () => {
    const r = await request(ctx.app).get('/api/plans');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('price_pro');
    const pro = r.body.data.find((p: { id: string }) => p.id === 'pro');
    expect(pro).toMatchObject({ purchasable: true, priceCents: 900 });
    expect(r.body.data.find((p: { id: string }) => p.id === 'free').purchasable).toBe(false);
  });
});

describe('billing', () => {
  const event = (id: string, type: string, object: unknown) => JSON.stringify({ id, object: 'event', type, data: { object } });
  const sign = (payload: string) => realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  const hook = (payload: string, sig = sign(payload)) => request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(payload);
  const sub = (userId: string, over: Record<string, unknown> = {}) => ({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { userId }, cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 86400, items: { data: [{ price: { id: 'price_pro' } }] }, ...over });

  it('requires sign-in and a valid plan to start checkout', async () => {
    expect((await request(ctx.app).post('/api/billing/checkout').send({ plan: 'pro' })).status).toBe(401);
    const u = await signup();
    expect((await request(ctx.app).post('/api/billing/checkout').set(auth(u.token)).send({ plan: 'free' })).status).toBe(400);
    expect((await request(ctx.app).post('/api/billing/checkout').set(auth(u.token)).send({ plan: 'enterprise' })).status).toBe(400);
  });
  it('creates a Stripe checkout session for the configured price, bound to the user', async () => {
    const u = await signup();
    calls.sessions.length = 0;
    const r = await request(ctx.app).post('/api/billing/checkout').set(auth(u.token)).send({ plan: 'pro' });
    expect(r.status).toBe(200); expect(r.body.data.url).toBe('https://stripe.test/c/1');
    expect(calls.sessions[0]).toMatchObject({ mode: 'subscription', client_reference_id: u.id, line_items: [{ price: 'price_pro', quantity: 1 }] });
    expect(JSON.stringify(calls.sessions[0])).not.toContain('sk_test'); // no secrets in params
    expect((await request(ctx.app).post('/api/billing/portal').set(auth(u.token))).body.data.url).toBe('https://stripe.test/p/1');
  });
  it('rejects webhooks with a missing or forged signature', async () => {
    const u = await signup();
    const p = event('evt_bad1', 'customer.subscription.updated', sub(u.id));
    expect((await request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(p)).status).toBe(400);
    expect((await hook(p, 't=1,v1=deadbeef')).status).toBe(400);
    expect((await UserModel.findById(u.id))!.plan).toBe('free');
  });
  it('upgrades on an active subscription, is idempotent, and downgrades on cancellation', async () => {
    const u = await signup();
    const p = event('evt_up1', 'customer.subscription.updated', sub(u.id));
    const r1 = await hook(p);
    expect(r1.status).toBe(200); expect(r1.body.duplicate).toBe(false);
    let doc = await UserModel.findById(u.id);
    expect(doc!.plan).toBe('pro'); expect(doc!.billing.status).toBe('active');
    expect((await hook(p)).body.duplicate).toBe(true); // Stripe retries are harmless
    // admin-visible plan reflects in entitlements
    expect((await request(ctx.app).get('/api/me').set(auth(u.token))).body.data.plan).toBe('pro');
    await hook(event('evt_del1', 'customer.subscription.deleted', sub(u.id, { status: 'canceled' })));
    doc = await UserModel.findById(u.id);
    expect(doc!.plan).toBe('free'); expect(doc!.billing.status).toBe('canceled');
  });
  it('keeps access during past_due, removes it when unpaid, and ignores unmapped prices', async () => {
    const u = await signup();
    await hook(event('evt_a', 'customer.subscription.updated', sub(u.id)));
    await hook(event('evt_b', 'customer.subscription.updated', sub(u.id, { status: 'past_due' })));
    expect((await UserModel.findById(u.id))!.plan).toBe('pro');
    await hook(event('evt_c', 'customer.subscription.updated', sub(u.id, { items: { data: [{ price: { id: 'price_mystery' } }] } })));
    expect((await UserModel.findById(u.id))!.plan).toBe('pro'); // unchanged
    await hook(event('evt_d', 'customer.subscription.updated', sub(u.id, { status: 'unpaid' })));
    expect((await UserModel.findById(u.id))!.plan).toBe('free');
  });
  it('maps business prices and tolerates events for unknown users', async () => {
    const u = await signup();
    await hook(event('evt_e', 'customer.subscription.created', sub(u.id, { items: { data: [{ price: { id: 'price_biz' } }] } })));
    expect((await UserModel.findById(u.id))!.plan).toBe('business');
    expect((await hook(event('evt_f', 'customer.subscription.updated', sub('0'.repeat(24), { customer: 'cus_nobody' })))).status).toBe(200);
    expect((await hook(event('evt_g', 'invoice.paid', {}))).status).toBe(200);
  });
  it('refuses a second checkout while subscribed', async () => {
    const u = await signup();
    await hook(event('evt_h', 'customer.subscription.updated', sub(u.id)));
    expect((await request(ctx.app).post('/api/billing/checkout').set(auth(u.token)).send({ plan: 'business' })).status).toBe(409);
  });
  it('reports "not configured" instead of faking anything when Stripe is absent', async () => {
    const b = new BillingService(ctx.env, ctx.settings, pino({ level: 'silent' }), null);
    expect(b.enabled).toBe(false);
    await expect(b.checkout({ billing: {} }, 'pro')).rejects.toMatchObject({ status: 503, code: 'billing_not_configured' });
    await expect(b.handleWebhook(Buffer.from('{}'), 'x')).rejects.toMatchObject({ code: 'billing_not_configured' });
  });
});

describe('account deletion and restart reconciliation', () => {
  it('deletes the account, sessions, job files and cancels the subscription', async () => {
    const u = await signup();
    const hookEv = JSON.stringify({ id: 'evt_del_acct', object: 'event', type: 'customer.subscription.updated', data: { object: { id: 'sub_9', customer: 'cus_9', status: 'active', metadata: { userId: u.id }, cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro' } }] } } } });
    await request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', realStripe.webhooks.generateTestHeaderString({ payload: hookEv, secret: 'whsec_test' })).send(hookEv);
    const r = await request(ctx.app).post('/api/pdf/rotate').set(auth(u.token)).attach('files', await pdf(1), 'a.pdf');
    const job = await waitDone(u.token, r.body.data.jobId);
    expect(existsSync(join(ctx.jobs.root, job.id))).toBe(true);
    expect((await request(ctx.app).delete('/api/me').set(auth(u.token)).send({ password: 'wrong-password-1' })).status).toBe(403);
    calls.cancelled.length = 0;
    expect((await request(ctx.app).delete('/api/me').set(auth(u.token)).send({ password: PW })).status).toBe(200);
    expect(existsSync(join(ctx.jobs.root, job.id))).toBe(false);
    expect(await UserModel.findById(u.id)).toBeNull();
    expect(await SessionModel.countDocuments({ userId: u.id })).toBe(0);
    expect(await ctx.jobs.store.get(job.id)).toBeUndefined();
    expect(calls.cancelled).toContain('sub_9');
    expect((await request(ctx.app).get('/api/me').set(auth(u.token))).status).toBe(401);
  });
  it('on startup: keeps every job record\'s files, deletes only OLD unknown directories, never touches live jobs', async () => {
    const store = new MongoJobStore();
    const root = join(storage, 'jobs');
    const mk = async (id: string, state: string) => {
      await mkdir(join(root, id, 'in'), { recursive: true }); await writeFile(join(root, id, 'in', 'x'), 'x');
      await store.create({ id, owner: 'g:abc', tool: 'rotate', state, progress: 0, options: {}, inputs: [], dir: join(root, id), createdAt: Date.now(), expiresAt: Date.now() + 1e6, warnings: [], plan: 'guest', priority: 0, limits: { maxPages: 5 }, usageKeys: [] } as never);
    };
    const [done, running, queued] = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    await mk(done!, 'completed'); await mk(running!, 'processing'); await mk(queued!, 'queued');
    const oldOrphan = join(root, 'd'.repeat(32)), freshOrphan = join(root, 'e'.repeat(32));
    await mkdir(oldOrphan, { recursive: true }); await mkdir(freshOrphan, { recursive: true });
    const { utimes } = await import('node:fs/promises');
    await utimes(oldOrphan, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    // A second API instance starting up must not disturb the first one's jobs (the old single-instance hazard).
    const other = new JobService(ctx.env, store, pino({ level: 'silent' }), ctx.jobs.queue, null);
    await other.init();
    const dirs = await readdir(root);
    expect(dirs).toEqual(expect.arrayContaining([done, running, queued, 'e'.repeat(32)]));
    expect(dirs).not.toContain('d'.repeat(32));
    expect((await store.get(running!))!.state).toBe('processing'); // untouched by startup
  });
});

describe('authorization matrix (accounts mode)', () => {
  const PUBLIC = ['GET /api/config', 'GET /api/openapi.json', 'GET /api/plans', 'GET /api/tools', 'GET /health', 'GET /ready'];
  const AUTH_FLOW = ['POST /api/auth/forgot-password', 'POST /api/auth/login', 'POST /api/auth/login/2fa', 'POST /api/auth/login/2fa/key', 'POST /api/auth/login/2fa/key/options', 'POST /api/auth/logout', 'POST /api/auth/refresh', 'POST /api/auth/register', 'POST /api/auth/reset-password', 'POST /api/auth/verify-email'];
  const USER = ['DELETE /api/me/security-keys/:id', 'GET /api/me/security-keys', 'POST /api/me/security-keys', 'POST /api/me/security-keys/options', 'DELETE /api/teams/mine', 'DELETE /api/teams/mine/invites/:id', 'DELETE /api/teams/mine/members/:userId', 'GET /api/teams/mine', 'PATCH /api/teams/mine', 'PATCH /api/teams/mine/members/:userId', 'POST /api/billing/team/checkout', 'POST /api/billing/team/portal', 'POST /api/teams', 'POST /api/teams/invites/accept', 'POST /api/teams/mine/invites', 'POST /api/teams/mine/leave', 'POST /api/teams/mine/transfer', 'DELETE /api/auth/sessions/:id', 'GET /api/auth/sessions', 'POST /api/auth/resend-verification', 'POST /api/auth/sessions/revoke-others', 'POST /api/me/2fa/disable', 'POST /api/me/2fa/enable', 'POST /api/me/2fa/recovery-codes', 'POST /api/me/2fa/setup', 'DELETE /api/me', 'GET /api/me', 'GET /api/me/jobs', 'GET /api/me/usage', 'PATCH /api/me', 'POST /api/billing/checkout', 'POST /api/billing/portal', 'POST /api/me/password'];
  const ADMIN = ['DELETE /api/admin/teams/:id', 'GET /api/admin/teams', 'GET /api/admin/teams/:id', 'POST /api/admin/teams/:id/transfer', 'GET /api/admin/audit', 'GET /api/admin/dashboard', 'GET /api/admin/jobs', 'GET /api/admin/settings', 'GET /api/admin/usage', 'GET /api/admin/users', 'PATCH /api/admin/users/:id', 'POST /api/admin/users/:id/2fa/reset', 'PUT /api/admin/settings'];
  const OWNER = ['DELETE /api/files/:fileId', 'GET /api/files/:fileId/download', 'GET /api/jobs/:jobId', 'POST /api/jobs/:jobId/cancel'];
  const PROCESSING = ['POST /api/pdf/:tool'];
  const WEBHOOK = ['POST /api/billing/webhook'];
  const OPERATIONAL = ['GET /metrics']; // token-gated in production, internal port, never under /api

  it('has no unclassified routes', () => {
    expect(listRoutes(ctx.app)).toEqual([...PUBLIC, ...AUTH_FLOW, ...USER, ...ADMIN, ...OWNER, ...PROCESSING, ...WEBHOOK, ...OPERATIONAL].sort());
  });

  const call = (route: string, headers: Record<string, string> = {}) => {
    const [m, p] = route.split(' ') as [string, string];
    const path = p.replace(':id', '0'.repeat(24)).replace(':userId', '0'.repeat(24)).replace(':fileId', '0'.repeat(48)).replace(':jobId', '0'.repeat(32)).replace(':tool', 'rotate');
    const r = request(ctx.app)[m.toLowerCase() as 'get'](path).set(headers);
    return m === 'GET' ? r : r.send({});
  };

  it('every user route rejects anonymous callers with 401', async () => {
    for (const r of USER) expect((await call(r)).status, r).toBe(401);
  });
  it('every admin route: anonymous 401, regular user 403', async () => {
    const u = await signup();
    for (const r of ADMIN) {
      expect((await call(r)).status, `${r} anon`).toBe(401);
      expect((await call(r, auth(u.token))).status, `${r} user`).toBe(403);
    }
  });
  it('the webhook ignores sessions and requires a valid Stripe signature', async () => {
    const u = await signup();
    expect((await request(ctx.app).post('/api/billing/webhook').set(auth(u.token)).set('Content-Type', 'application/json').send('{}')).status).toBe(400);
    expect((await request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'text/plain').send('hello')).status).toBe(400);
    expect((await request(ctx.app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=00').send('{"id":"x"}')).status).toBe(400);
  });
});

describe('token forgery and injection attacks', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = (sub: string, over: object = {}) => ({ sub, role: 'admin', iss: 'pdftools', aud: 'pdftools-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...over });
  const me = (t: string) => request(ctx.app).get('/api/admin/users').set(auth(t));

  it('rejects alg=none tokens, even with an admin subject', async () => {
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims(admin.id))}.`;
    expect((await me(none)).status).toBe(401);
    expect((await me(none.slice(0, -1))).status).toBe(401);
  });
  it('rejects tokens signed with the wrong key, wrong audience, wrong issuer or expired', async () => {
    const sign = (secret: string, c: object, alg = 'HS256') => new SignJWT(c as Record<string, unknown>).setProtectedHeader({ alg }).sign(new TextEncoder().encode(secret));
    expect((await me(await sign('x'.repeat(40), claims(admin.id)))).status).toBe(401);
    const good = ctx.env.JWT_ACCESS_SECRET;
    expect((await me(await sign(good, claims(admin.id, { aud: 'someone-else' })))).status).toBe(401);
    expect((await me(await sign(good, claims(admin.id, { iss: 'evil' })))).status).toBe(401);
    expect((await me(await sign(good, claims(admin.id, { exp: Math.floor(Date.now() / 1000) - 10 })))).status).toBe(401);
    expect((await me(await sign(good, claims(admin.id, { exp: undefined, sub: undefined })))).status).toBe(401);
    // control: the same construction with every claim right is accepted, so the rejections above are about the forgery, not the helper
    expect((await me(await sign(good, claims(admin.id)))).status).toBe(200);
  });
  it('rejects a valid token whose user no longer exists', async () => {
    const u = await signup();
    await UserModel.deleteOne({ _id: u.id });
    expect((await request(ctx.app).get('/api/me').set(auth(u.token))).status).toBe(401);
  });
  it('ignores privileged fields in profile updates and registration (no mass assignment)', async () => {
    const u = await signup();
    const r = await request(ctx.app).patch('/api/me').set(auth(u.token)).send({ name: 'Renamed', role: 'admin', plan: 'business', status: 'disabled', passwordHash: 'x' });
    expect(r.status).toBe(200);
    const doc = await UserModel.findById(u.id);
    expect(doc!.role).toBe('user'); expect(doc!.plan).toBe('free'); expect(doc!.status).toBe('active'); expect(doc!.name).toBe('Renamed');
    const reg = await request(ctx.app).post('/api/auth/register').send({ email: `mass${n++}@example.com`, password: PW, role: 'admin', plan: 'business' });
    expect(reg.body.data.user.role).toBe('user'); expect(reg.body.data.user.plan).toBe('free');
  });
  it('rejects NoSQL operator injection in credentials, query strings and cookies', async () => {
    const u = await signup();
    expect((await request(ctx.app).post('/api/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: { $ne: 'x' } })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/forgot-password').send({ email: { $regex: '.*' } })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token: { $ne: '' }, password: PW })).status).toBe(400);
    expect((await request(ctx.app).get('/api/admin/jobs?state[$ne]=x').set(auth(admin.token))).status).toBe(400);
    expect((await request(ctx.app).get('/api/admin/users?q[$ne]=x').set(auth(admin.token))).status).toBe(400);
    const inj = await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', 'pt_refresh[$ne]=x');
    expect(inj.status).toBe(401);
  });
  it('treats a user-supplied job/file id as data, never as a query', async () => {
    const u = await signup();
    for (const id of ['{"$ne":"x"}', '$where', '%7B%22%24ne%22%3A1%7D']) expect((await request(ctx.app).get(`/api/jobs/${encodeURIComponent(id)}`).set(auth(u.token))).status).toBe(404);
  });
});
