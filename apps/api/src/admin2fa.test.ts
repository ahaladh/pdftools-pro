import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, SessionModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { adminTwoFactorRequired } from './modules/auth/policy.js';
import { requireAdminTwoFactor } from './modules/auth/middleware.js';
import { base32Decode, totpAt } from './modules/auth/totp.js';
import { SoftKey } from './testing/softkey.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const PW = 'correct horse battery';
let n = 0;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });


/** A fresh account, made an administrator directly in the database (as the seeded one is). */
async function newAdmin() {
  const email = `a${n++}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'Admin' });
  expect(r.status).toBe(201);
  await UserModel.updateOne({ email }, { $set: { role: 'admin' } });
  return { email, token: r.body.data.accessToken as string, id: r.body.data.user.id as string };
}
const newUser = async () => {
  const email = `u${n++}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'U' });
  return { email, token: r.body.data.accessToken as string, id: r.body.data.user.id as string };
};
/** Turn on an authenticator app; returns the secret, recovery codes and the new token. */
async function addTotp(u: { token: string }) {
  const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
  const secret = base32Decode(setup.body.data.secret);
  const en = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: totpAt(secret, Date.now()) });
  expect(en.status, JSON.stringify(en.body)).toBe(200);
  return { secret, recovery: en.body.data.recoveryCodes as string[], token: en.body.data.accessToken as string };
}
async function addKey(u: { token: string }, key = new SoftKey()) {
  const o = await request(ctx.app).post('/api/me/security-keys/options').set(bearer(u.token)).send({ password: PW });
  const r = await request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response: key.create(o.body.data), name: 'k' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { key, token: (r.body.data.accessToken as string | undefined) ?? u.token, recovery: r.body.data.recoveryCodes as string[] | undefined };
}
const dash = (t: string) => request(ctx.app).get('/api/admin/dashboard').set(bearer(t));
const users = (t: string) => request(ctx.app).get('/api/admin/users').set(bearer(t));
const removeKey = (t: string, id: string, code: string) => request(ctx.app).delete(`/api/me/security-keys/${id}`).set(bearer(t)).send({ password: PW, code });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'adm-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123', REQUIRE_ADMIN_2FA: 'true',
  });
  ctx = await createApp({ env, mailer });
  await UserModel.createIndexes();
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('the policy setting', () => {
  it('defaults to on in production and off elsewhere; an explicit value always wins', () => {
    const e = (x: Record<string, string>) => loadEnv({ DOWNLOAD_SECRET: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8', ...x });
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'production' }))).toBe(true);
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'development' }))).toBe(false);
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'test' }))).toBe(false);
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'production', REQUIRE_ADMIN_2FA: 'false' }))).toBe(false);
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'development', REQUIRE_ADMIN_2FA: 'true' }))).toBe(true);
    expect(adminTwoFactorRequired(e({ NODE_ENV: 'production', REQUIRE_ADMIN_2FA: '' }))).toBe(true); // empty = unset
  });

  it('the gate itself: off lets everyone through; on stops an admin with no factor and no one else', () => {
    const run = (env: { REQUIRE_ADMIN_2FA?: boolean; NODE_ENV: string }, user: object) => {
      let err: { code?: string } | undefined;
      requireAdminTwoFactor(env as never)({ user } as never, {} as never, ((e?: { code?: string }) => { err = e; }) as never);
      return err?.code;
    };
    expect(run({ REQUIRE_ADMIN_2FA: false, NODE_ENV: 'production' }, {})).toBeUndefined();
    expect(run({ REQUIRE_ADMIN_2FA: true, NODE_ENV: 'test' }, {})).toBe('two_factor_required');
    expect(run({ REQUIRE_ADMIN_2FA: true, NODE_ENV: 'test' }, { twoFactor: { enabledAt: new Date() } })).toBeUndefined();
    expect(run({ REQUIRE_ADMIN_2FA: true, NODE_ENV: 'test' }, { securityKeys: [{}] })).toBeUndefined();
    // recovery codes or a half-finished setup do not count as a second factor
    expect(run({ REQUIRE_ADMIN_2FA: true, NODE_ENV: 'test' }, { twoFactor: { recoveryHashes: ['x'] }, twoFactorPending: { secretEnc: 'x' } })).toBe('two_factor_required');
  });

  it('the public config says whether it applies', async () => {
    expect((await request(ctx.app).get('/api/config')).body.data.features.adminTwoFactor).toBe(true);
  });
});

describe('the admin area with the policy on', () => {
  it('an administrator without a second factor is refused everywhere in the admin area, but can still reach their account to set one up', async () => {
    const a = await newAdmin();
    for (const r of [await dash(a.token), await users(a.token), await request(ctx.app).get('/api/admin/settings').set(bearer(a.token)), await request(ctx.app).patch(`/api/admin/users/${a.id}`).set(bearer(a.token)).send({ plan: 'pro' })]) {
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('two_factor_required'); expect(r.body.error.message).toMatch(/account page/);
    }
    expect((await request(ctx.app).get('/api/me').set(bearer(a.token))).status).toBe(200);
    expect((await UserModel.findById(a.id))!.plan).toBe('free'); // the refused PATCH changed nothing
  });

  it('an ordinary user still just gets "forbidden", with no hint about the policy', async () => {
    const u = await newUser();
    const r = await dash(u.token);
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('forbidden');
  });

  it('enrolling an authenticator app opens it; so does a security key', async () => {
    const a = await newAdmin();
    const t = await addTotp(a);
    expect((await dash(t.token)).status).toBe(200);
    const b = await newAdmin();
    const k = await addKey(b);
    expect((await dash(k.token)).status).toBe(200);
    // and the old (pre-enrolment) token works too, because the state is read from the database, not the token
    expect((await dash(a.token)).status).toBe(200);
  });

  it('the dashboard counts administrators who are not protected yet', async () => {
    const a = await newAdmin(); const t = await addTotp(a);
    const bare = await newAdmin();
    const d = (await dash(t.token)).body.data.users;
    expect(d.twoFactorRequired).toBe(true);
    expect(d.adminsWithoutTwoFactor).toBeGreaterThanOrEqual(1);
    const before = d.adminsWithoutTwoFactor;
    await addTotp({ token: bare.token });
    expect((await dash(t.token)).body.data.users.adminsWithoutTwoFactor).toBe(before - 1);
  });

  it('a user promoted to administrator is locked out of the admin area until they enrol', async () => {
    const boss = await newAdmin(); const t = await addTotp(boss);
    const u = await newUser();
    expect((await request(ctx.app).patch(`/api/admin/users/${u.id}`).set(bearer(t.token)).send({ role: 'admin' })).status).toBe(200);
    expect((await users(u.token)).body.error.code).toBe('two_factor_required');
    const e = await addTotp(u);
    expect((await users(e.token)).status).toBe(200);
  });
});

describe('an administrator cannot switch the protection off', () => {
  it('not by turning off the authenticator app when it is the only factor; yes once a key is also registered', async () => {
    const a = await newAdmin();
    const t = await addTotp(a);
    const off = await request(ctx.app).post('/api/me/2fa/disable').set(bearer(t.token)).send({ password: PW, code: t.recovery[0] });
    expect(off.status).toBe(409); expect(off.body.error.code).toBe('admin_requires_two_factor');
    expect((await UserModel.findById(a.id))!.twoFactor.enabledAt).toBeTruthy();
    expect((await dash(t.token)).status).toBe(200);
    const k = await addKey({ token: t.token });
    const ok = await request(ctx.app).post('/api/me/2fa/disable').set(bearer(k.token)).send({ password: PW, code: t.recovery[1] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200); // a key still protects the account
    expect((await dash(ok.body.data.accessToken)).status).toBe(200);
  });

  it('not by removing the last security key; one of two can go', async () => {
    const a = await newAdmin();
    const first = await addKey(a);
    const second = await addKey({ token: first.token });
    const recovery = first.recovery!;
    const one = await removeKey(second.token, first.key.id, recovery[0]!);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const last = await removeKey(one.body.data.accessToken, second.key.id, recovery[1]!);
    expect(last.status).toBe(409); expect(last.body.error.code).toBe('admin_requires_two_factor');
    expect((await UserModel.findById(a.id))!.securityKeys).toHaveLength(1);
    // removing the key while an authenticator app remains is fine
    const t = await addTotp({ token: one.body.data.accessToken });
    expect((await removeKey(t.token, second.key.id, t.recovery[0]!)).status).toBe(200);
  });

  it('an ordinary user is not restricted at all', async () => {
    const u = await newUser(); const t = await addTotp(u);
    expect((await request(ctx.app).post('/api/me/2fa/disable').set(bearer(t.token)).send({ password: PW, code: t.recovery[0] })).status).toBe(200);
  });

  it('nor by resetting their own factors through the admin area; another administrator can, and the reset admin is gated again', async () => {
    const a = await newAdmin(); const ta = await addTotp(a);
    const b = await newAdmin(); const tb = await addTotp(b);
    const self = await request(ctx.app).post(`/api/admin/users/${a.id}/2fa/reset`).set(bearer(ta.token));
    expect(self.status).toBe(409); expect(self.body.error.code).toBe('cannot_reset_own');
    expect((await UserModel.findById(a.id))!.twoFactor.enabledAt).toBeTruthy();
    const other = await request(ctx.app).post(`/api/admin/users/${a.id}/2fa/reset`).set(bearer(tb.token));
    expect(other.status).toBe(200);
    expect((await dash(ta.token)).body.error.code).toBe('two_factor_required'); // locked out again until they re-enrol
    expect(await SessionModel.countDocuments({ userId: a.id, revokedAt: { $exists: false } })).toBe(0);
    const login = await request(ctx.app).post('/api/auth/login').send({ email: a.email, password: PW });
    expect(login.body.data.accessToken).toBeTruthy(); // can still sign in, to enrol
  });
});
