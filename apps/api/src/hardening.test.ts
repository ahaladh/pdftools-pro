import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { SignJWT } from 'jose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, AuditModel, SessionModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { billingRoutes } from './modules/billing/routes.js';
import { describeDevice } from './modules/auth/service.js';
import { base32Decode, totpAt } from './modules/auth/totp.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const JWT = 'j'.repeat(40);
const PW = 'correct horse battery';
let n = 0;

const cookieOf = (res: request.Response, name: string) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith(`${name}=`));
const refreshOf = (res: request.Response) => cookieOf(res, 'pt_refresh')?.split(';')[0]?.split('=')[1];
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const tokenIn = (m: { text: string }) => /token=([\w-]+)/.exec(m.text)![1]!;
const lastMail = () => mailer.sent[mailer.sent.length - 1]!;

async function signup(ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537') {
  const email = `h${n++}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').set('User-Agent', ua).send({ email, password: PW, name: 'T' });
  expect(r.status).toBe(201);
  return { email, token: r.body.data.accessToken as string, refresh: refreshOf(r)!, id: r.body.data.user.id as string };
}
const login = (email: string, ua = 'Mozilla/5.0 (Windows NT 10.0) Firefox/121.0') => request(ctx.app).post('/api/auth/login').set('User-Agent', ua).send({ email, password: PW });

/** Turn on 2FA for a fresh user; returns the secret (to make codes), recovery codes and the new session. */
async function withTwoFactor() {
  const u = await signup();
  const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.data.secret);
  const en = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: totpAt(secret, Date.now()) });
  expect(en.status, JSON.stringify(en.body)).toBe(200);
  return { ...u, secret, recovery: en.body.data.recoveryCodes as string[], token: en.body.data.accessToken as string, refresh: refreshOf(en)! };
}
/** A login challenge for this user (password step). */
const challengeFor = async (email: string) => (await login(email)).body.data.challenge as string;
const second = (challenge: string, code: string) => request(ctx.app).post('/api/auth/login/2fa').send({ challenge, code });
const code = (secret: Buffer) => totpAt(secret, Date.now());
/**
 * Freeze the clock exactly `steps` TOTP periods ahead of real time and return that moment's code. Deterministic however
 * far into the current 30 s window the test happens to start (a real-clock offset is not).
 */
const at = (secret: Buffer, steps: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + steps * 30_000); return totpAt(secret, Date.now()); };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'hard-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: JWT,
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123',
  });
  ctx = await createApp({ env, mailer });
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('email verification', () => {
  it('registration sends a confirmation link; the account starts unverified and the token is stored only as a hash', async () => {
    const before = mailer.sent.length;
    const u = await signup();
    expect(mailer.sent.length).toBe(before + 1);
    expect(lastMail().to).toBe(u.email); expect(lastMail().text).toContain('/verify-email?token=');
    expect((await request(ctx.app).get('/api/me').set(bearer(u.token))).body.data).toMatchObject({ emailVerified: false, twoFactorEnabled: false });
    const raw = tokenIn(lastMail());
    expect(JSON.stringify((await UserModel.findOne({ email: u.email }))!.toObject())).not.toContain(raw);
  });

  it('the link confirms the address once; reuse, garbage and expired tokens are refused', async () => {
    const u = await signup();
    const t = tokenIn(lastMail());
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: t })).status).toBe(200);
    expect((await request(ctx.app).get('/api/me').set(bearer(u.token))).body.data.emailVerified).toBe(true);
    const again = await request(ctx.app).post('/api/auth/verify-email').send({ token: t });
    expect(again.status).toBe(400); expect(again.body.error.code).toBe('invalid_token');
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: 'x'.repeat(43) })).status).toBe(400);
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: 'short' })).status).toBe(400);
    const u2 = await signup(); const t2 = tokenIn(lastMail());
    await UserModel.updateOne({ email: u2.email }, { verifyTokenExpires: new Date(Date.now() - 1000) });
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: t2 })).status).toBe(400);
  });

  it('resend is rate limited, replaces the old link, needs a session and refuses once verified', async () => {
    const u = await signup(); const first = tokenIn(lastMail());
    expect((await request(ctx.app).post('/api/auth/resend-verification')).status).toBe(401);
    const soon = await request(ctx.app).post('/api/auth/resend-verification').set(bearer(u.token));
    expect(soon.status).toBe(429); expect(soon.body.error.code).toBe('too_soon');
    await UserModel.updateOne({ email: u.email }, { verifySentAt: new Date(Date.now() - 120_000) });
    const sent = mailer.sent.length;
    expect((await request(ctx.app).post('/api/auth/resend-verification').set(bearer(u.token))).status).toBe(200);
    expect(mailer.sent.length).toBe(sent + 1);
    const second = tokenIn(lastMail());
    expect(second).not.toBe(first);
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: first })).status).toBe(400); // superseded
    expect((await request(ctx.app).post('/api/auth/verify-email').send({ token: second })).status).toBe(200);
    expect((await request(ctx.app).post('/api/auth/resend-verification').set(bearer(u.token))).body.error.code).toBe('already_verified');
  });

  it('completing a password reset proves the inbox, so it also verifies the address', async () => {
    const u = await signup();
    await request(ctx.app).post('/api/auth/forgot-password').send({ email: u.email });
    const t = tokenIn(lastMail());
    expect((await request(ctx.app).post('/api/auth/reset-password').send({ token: t, password: 'a brand new password' })).status).toBe(200);
    expect((await UserModel.findOne({ email: u.email }))!.emailVerifiedAt).toBeTruthy();
  });

  it('can gate checkout: unverified accounts are refused, verified ones go through', async () => {
    const billing = { checkout: async () => 'https://pay.test/c', portal: async () => 'x' } as never;
    const mk = (verified: boolean, required: boolean) => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.user = { emailVerifiedAt: verified ? new Date() : undefined }; next(); });
      app.use('/b', billingRoutes(billing, { requireVerifiedEmail: required }));
      app.use((e: { status?: number; code?: string }, _q: express.Request, res: express.Response, _n: express.NextFunction) => res.status(e.status ?? 500).json({ code: e.code }));
      return app;
    };
    const refused = await request(mk(false, true)).post('/b/checkout').send({ plan: 'pro' });
    expect(refused.status).toBe(403); expect(refused.body.code).toBe('email_unverified');
    expect((await request(mk(true, true)).post('/b/checkout').send({ plan: 'pro' })).status).toBe(200);
    expect((await request(mk(false, false)).post('/b/checkout').send({ plan: 'pro' })).status).toBe(200); // gate is opt-in
  });
});

describe('two-factor sign-in: setup', () => {
  it('needs the password, shows the secret and a QR code, and enforces nothing until a code is proven', async () => {
    const u = await signup();
    expect((await request(ctx.app).post('/api/me/2fa/setup').send({ password: PW })).status).toBe(401);
    expect((await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: 'wrong password!' })).status).toBe(403);
    const r = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
    expect(r.status).toBe(200);
    expect(r.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(r.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(Buffer.from(r.body.data.qr.split(',')[1], 'base64').toString()).toContain('<svg');
    expect((await login(u.email)).body.data.accessToken).toBeTruthy(); // still plain password login: not enabled yet
    expect((await UserModel.findOne({ email: u.email }))!.twoFactorPending.secretEnc).not.toContain(r.body.data.secret); // encrypted at rest
  });

  it('a wrong or stale code does not enable it; a right one does, shows 10 recovery codes once and signs other devices out', async () => {
    const u = await signup();
    const other = await login(u.email); const otherRefresh = refreshOf(other)!;
    const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
    const secret = base32Decode(setup.body.data.secret);
    const bad = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: '000000' });
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('invalid_code');
    const ok = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: code(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.recoveryCodes).toHaveLength(10);
    expect(ok.body.data.user.twoFactorEnabled).toBe(true);
    const refreshed = await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${otherRefresh}`).set('X-PDFTools-CSRF', '1');
    expect(refreshed.status).toBe(401); // the other device was signed out
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${refreshOf(ok)}`).set('X-PDFTools-CSRF', '1')).status).toBe(200); // this one was reissued
    const row = (await UserModel.findOne({ email: u.email }))!.toObject();
    const text = JSON.stringify(row);
    for (const c of ok.body.data.recoveryCodes as string[]) expect(text).not.toContain(c); // only hashes stored
    expect(text).not.toContain(setup.body.data.secret);
    expect((await request(ctx.app).post('/api/me/2fa/setup').set(bearer(ok.body.data.accessToken)).send({ password: PW })).status).toBe(409); // already on
  });

  it('an abandoned setup expires', async () => {
    const u = await signup();
    const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
    await UserModel.updateOne({ email: u.email }, { 'twoFactorPending.createdAt': new Date(Date.now() - 16 * 60_000) });
    const r = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: code(base32Decode(setup.body.data.secret)) });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('no_pending_setup');
  });
});

describe('two-factor sign-in: logging in', () => {
  it('a correct password alone yields only a challenge: no session, no cookie, and the challenge is not an access token', async () => {
    const u = await withTwoFactor();
    const r = await login(u.email);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(cookieOf(r, 'pt_refresh')).toBeUndefined();
    expect((await request(ctx.app).get('/api/me').set(bearer(r.body.data.challenge))).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: 'nope nope nope' })).status).toBe(401);
  });

  it('the second factor completes the login; a wrong code does not', async () => {
    const u = await withTwoFactor();
    const ch = await challengeFor(u.email);
    const bad = await second(ch, '000000');
    expect(bad.status).toBe(401); expect(bad.body.error.code).toBe('invalid_code');
    const ok = await second(ch, at(u.secret, 1)); // next step: ahead of the one used to enable (which is now spent)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.user.twoFactorEnabled).toBe(true);
    expect(refreshOf(ok)).toBeTruthy();
    expect((await request(ctx.app).get('/api/me').set(bearer(ok.body.data.accessToken))).status).toBe(200);
  });

  it('a code cannot be replayed, even immediately, and even with a fresh challenge', async () => {
    const u = await withTwoFactor();
    const c = at(u.secret, 1);
    expect((await second(await challengeFor(u.email), c)).status).toBe(200);
    const replay = await second(await challengeFor(u.email), c); // clock still at that same instant
    expect(replay.status).toBe(401); expect(replay.body.error.code).toBe('invalid_code');
    expect((await second(await challengeFor(u.email), at(u.secret, 2))).status).toBe(200); // the next step is fine
  });

  it('the same code used in parallel succeeds exactly once', async () => {
    const u = await withTwoFactor();
    const c = at(u.secret, 1);
    const chs = await Promise.all(Array.from({ length: 6 }, () => challengeFor(u.email)));
    const results = await Promise.all(chs.map((ch) => second(ch, c)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('five wrong codes lock the account, even against the correct code, and the password step too', async () => {
    const u = await withTwoFactor();
    const ch = await challengeFor(u.email);
    for (let i = 0; i < 4; i++) expect((await second(ch, '111111')).status).toBe(401);
    expect((await second(ch, '111111')).status).toBe(401); // 5th wrong: now locked
    const locked = await second(ch, at(u.secret, 1));
    expect(locked.status).toBe(429); expect(locked.body.error.code).toBe('account_locked');
    expect((await login(u.email)).status).toBe(429);
    expect(await AuditModel.countDocuments({ actor: `u:${u.id}`, action: 'auth.2fa_failed' })).toBeGreaterThanOrEqual(5);
  });

  it('rejects expired, forged, malformed and wrong-purpose challenges', async () => {
    const u = await withTwoFactor();
    const key = new TextEncoder().encode(JWT);
    const mk = (over: { aud?: string; exp?: string; sub?: string; purpose?: string; secret?: Uint8Array }) => new SignJWT({ purpose: over.purpose ?? 'mfa' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(over.sub ?? u.id).setIssuer('pdftools').setAudience(over.aud ?? 'pdftools-mfa').setIssuedAt(Math.floor(Date.now() / 1000) - 3600).setExpirationTime(over.exp ?? '5m').sign(over.secret ?? key);
    const c = at(u.secret, 1);
    const cases: [string, string][] = [
      ['expired', await mk({ exp: '-10s' })],
      ['wrong audience (an access token shape)', await mk({ aud: 'pdftools-api' })],
      ['signed with another key', await mk({ secret: new TextEncoder().encode('z'.repeat(40)) })],
      ['wrong purpose', await mk({ purpose: 'login' })],
      ['unknown user', await mk({ sub: '0'.repeat(24) })],
      ['garbage', 'x'.repeat(40)],
    ];
    for (const [label, ch] of cases) { const r = await second(ch, c); expect(r.status, label).toBe(401); expect(r.body.error.code, label).toBe('invalid_challenge'); }
    // and a challenge for an account WITHOUT 2FA is useless
    const plain = await signup();
    expect((await second(await mk({ sub: plain.id }), '123456')).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/login/2fa').send({ challenge: 'short', code: '123456' })).status).toBe(400);
  });
});

describe('two-factor sign-in: recovery codes', () => {
  it('a recovery code works exactly once (any case or spacing), and is consumed', async () => {
    const u = await withTwoFactor();
    const rc = u.recovery[0]!;
    const ok = await second(await challengeFor(u.email), ` ${rc.toUpperCase().replace('-', ' ')} `);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await second(await challengeFor(u.email), rc);
    expect(again.status).toBe(401);
    expect((await UserModel.findOne({ email: u.email }))!.twoFactor.recoveryHashes).toHaveLength(9);
    expect((await second(await challengeFor(u.email), u.recovery[1]!)).status).toBe(200); // the others still work
  });

  it('the same recovery code used in parallel succeeds exactly once', async () => {
    const u = await withTwoFactor();
    const chs = await Promise.all(Array.from({ length: 6 }, () => challengeFor(u.email)));
    const results = await Promise.all(chs.map((ch) => second(ch, u.recovery[2]!)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('regenerating needs password and a code, and invalidates the old set', async () => {
    const u = await withTwoFactor();
    const body = { password: PW, code: at(u.secret, 1) };
    expect((await request(ctx.app).post('/api/me/2fa/recovery-codes').set(bearer(u.token)).send({ ...body, password: 'wrong password!' })).status).toBe(403);
    expect((await request(ctx.app).post('/api/me/2fa/recovery-codes').set(bearer(u.token)).send({ ...body, code: '000000' })).status).toBe(401);
    const r = await request(ctx.app).post('/api/me/2fa/recovery-codes').set(bearer(u.token)).send(body);
    expect(r.status).toBe(200); expect(r.body.data.recoveryCodes).toHaveLength(10);
    expect((await second(await challengeFor(u.email), u.recovery[0]!)).status).toBe(401); // old set is dead
    expect((await second(await challengeFor(u.email), r.body.data.recoveryCodes[0])).status).toBe(200);
  });
});

describe('two-factor sign-in: turning it off', () => {
  it('needs password AND a valid code; then plain password login works again and other devices are signed out', async () => {
    const u = await withTwoFactor();
    const dev = await second(await challengeFor(u.email), at(u.secret, 1)); const devRefresh = refreshOf(dev)!;
    const c = at(u.secret, 2);
    expect((await request(ctx.app).post('/api/me/2fa/disable').set(bearer(u.token)).send({ password: 'wrong password!', code: c })).status).toBe(403);
    expect((await request(ctx.app).post('/api/me/2fa/disable').set(bearer(u.token)).send({ password: PW, code: '000000' })).status).toBe(401);
    const off = await request(ctx.app).post('/api/me/2fa/disable').set(bearer(u.token)).send({ password: PW, code: c });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.user.twoFactorEnabled).toBe(false);
    expect((await login(u.email)).body.data.accessToken).toBeTruthy();
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${devRefresh}`).set('X-PDFTools-CSRF', '1')).status).toBe(401);
    const after = (await UserModel.findOne({ email: u.email }))!.toObject().twoFactor;
    expect(after?.enabledAt).toBeUndefined(); expect(after?.secretEnc).toBeUndefined(); expect(after?.recoveryHashes ?? []).toHaveLength(0);
  });

  it('an administrator can reset it for a locked-out user; ordinary users cannot; it is audited', async () => {
    const u = await withTwoFactor();
    const adminLogin = await login('root@example.com'); // the seeded admin has no 2FA
    const adminToken = (await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' })).body.data.accessToken as string;
    void adminLogin;
    const stranger = await signup();
    expect((await request(ctx.app).post(`/api/admin/users/${u.id}/2fa/reset`).set(bearer(stranger.token))).status).toBe(403);
    expect((await request(ctx.app).post(`/api/admin/users/${u.id}/2fa/reset`)).status).toBe(401);
    const r = await request(ctx.app).post(`/api/admin/users/${u.id}/2fa/reset`).set(bearer(adminToken));
    expect(r.status).toBe(200); expect(r.body.data.twoFactorEnabled).toBe(false);
    expect((await login(u.email)).body.data.accessToken).toBeTruthy();
    expect(await AuditModel.countDocuments({ actor: `u:${u.id}`, action: 'auth.2fa_reset_by_admin' })).toBe(1);
    expect((await request(ctx.app).post(`/api/admin/users/${u.id}/2fa/reset`).set(bearer(adminToken))).status).toBe(409); // nothing left to reset
    expect((await request(ctx.app).post('/api/admin/users/not-an-id/2fa/reset').set(bearer(adminToken))).status).toBe(404);
  });
});

describe('devices (sessions)', () => {
  it('lists signed-in devices, marks this one, and describes them', async () => {
    const u = await signup('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit Chrome/120 Safari/537');
    const second = await login(u.email, 'Mozilla/5.0 (Windows NT 10.0; Win64) Gecko/20100101 Firefox/121.0');
    const r = await request(ctx.app).get('/api/auth/sessions').set(bearer(u.token)).set('Cookie', `pt_refresh=${u.refresh}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    const cur = r.body.data.find((s: { current: boolean }) => s.current);
    expect(cur.device).toBe('Chrome on Linux');
    expect(r.body.data.find((s: { device: string }) => s.device === 'Firefox on Windows')).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/tokenHash|pt_refresh/); // never expose token material
    void second;
    expect((await request(ctx.app).get('/api/auth/sessions')).status).toBe(401);
  });

  it('a device can be signed out remotely; its refresh token stops working; other users cannot touch it', async () => {
    const u = await signup(); const other = await login(u.email); const otherRefresh = refreshOf(other)!;
    const list = (await request(ctx.app).get('/api/auth/sessions').set(bearer(u.token)).set('Cookie', `pt_refresh=${u.refresh}`)).body.data as { id: string; current: boolean }[];
    const target = list.find((s) => !s.current)!;
    const stranger = await signup();
    expect((await request(ctx.app).delete(`/api/auth/sessions/${target.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${otherRefresh}`).set('X-PDFTools-CSRF', '1')).status).toBe(200); // still alive (and rotated)
    const list2 = (await request(ctx.app).get('/api/auth/sessions').set(bearer(u.token)).set('Cookie', `pt_refresh=${u.refresh}`)).body.data as { id: string; current: boolean }[];
    expect(list2.find((s) => s.id === target.id)).toBeTruthy(); // rotation keeps the same device id
    expect((await request(ctx.app).delete(`/api/auth/sessions/${target.id}`).set(bearer(u.token))).status).toBe(200);
    expect((await request(ctx.app).delete(`/api/auth/sessions/${target.id}`).set(bearer(u.token))).status).toBe(404);
    const rotated = (await SessionModel.find({ family: target.id }).sort({ createdAt: -1 }))[0]!;
    expect(rotated.revokedAt).toBeTruthy();
  });

  it('"sign out everywhere else" keeps only this device', async () => {
    const u = await signup(); const a = refreshOf(await login(u.email))!; const b = refreshOf(await login(u.email))!;
    const r = await request(ctx.app).post('/api/auth/sessions/revoke-others').set(bearer(u.token)).set('Cookie', `pt_refresh=${u.refresh}`);
    expect(r.status).toBe(200); expect(r.body.data.revoked).toBe(2);
    for (const t of [a, b]) expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${t}`).set('X-PDFTools-CSRF', '1')).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/refresh').set('Cookie', `pt_refresh=${u.refresh}`).set('X-PDFTools-CSRF', '1')).status).toBe(200);
    // without the cookie we cannot tell which device is "this one", so refuse rather than guess
    expect((await request(ctx.app).post('/api/auth/sessions/revoke-others').set(bearer(u.token))).status).toBe(400);
  });

  it('describes user agents plainly', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari/605')).toBe('Safari on macOS');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome/120 Mobile Safari/537')).toBe('Chrome on Android');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120 Safari/537 Edg/120')).toBe('Edge on Windows');
    expect(describeDevice('curl/8.5.0')).toBe('API client');
    expect(describeDevice(undefined)).toBe('Unknown browser');
  });
});
