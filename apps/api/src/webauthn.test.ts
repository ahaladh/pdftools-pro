import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { disconnectDb, AuditModel, SessionModel, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { SecurityKeyService, webauthnConfig } from './modules/auth/webauthn.js';
import { base32Decode, totpAt } from './modules/auth/totp.js';
import { SoftKey } from './testing/softkey.js';

let mongo: MongoMemoryServer;
let storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
const mailer = new CaptureMailer();
const PW = 'correct horse battery';
let n = 0;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const refreshOf = (res: request.Response) => ((res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('pt_refresh=')))?.split(';')[0]?.split('=')[1];

async function signup() {
  const email = `w${n++}@example.com`;
  const r = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'T' });
  expect(r.status).toBe(201);
  return { email, token: r.body.data.accessToken as string, refresh: refreshOf(r)!, id: r.body.data.user.id as string };
}
const login = (email: string) => request(ctx.app).post('/api/auth/login').send({ email, password: PW });
const regOptions = (token: string, password = PW) => request(ctx.app).post('/api/me/security-keys/options').set(bearer(token)).send({ password });

/** Register `key` for the user through the real endpoints. Returns the response (which carries the new session for a first factor). */
async function addKey(u: { token: string }, key = new SoftKey(), name = 'My key') {
  const o = await regOptions(u.token);
  expect(o.status, JSON.stringify(o.body)).toBe(200);
  return request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response: key.create(o.body.data), name });
}
/** A user with one registered key, and their current (post-registration) token. */
async function withKey() {
  const u = await signup();
  const key = new SoftKey();
  const r = await addKey(u, key);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...u, key, token: r.body.data.accessToken as string, refresh: refreshOf(r)!, recovery: r.body.data.recoveryCodes as string[] };
}
const challengeFor = async (email: string) => (await login(email)).body.data.challenge as string;
const loginOptions = (challenge: string) => request(ctx.app).post('/api/auth/login/2fa/key/options').send({ challenge });
const loginKey = (challenge: string, response: unknown) => request(ctx.app).post('/api/auth/login/2fa/key').send({ challenge, response });
/** The whole second step with a key; `mutate` lets a test tamper with how the key answers. */
async function keySignIn(email: string, key: SoftKey, o: Parameters<SoftKey['get']>[1] = {}) {
  const challenge = await challengeFor(email);
  const opts = await loginOptions(challenge);
  expect(opts.status, JSON.stringify(opts.body)).toBe(200);
  return loginKey(challenge, key.get(opts.body.data, o));
}
const dbUser = (email: string) => UserModel.findOne({ email });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'wa-'));
  const env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: 'j'.repeat(40),
    ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'admin-password-123',
  });
  ctx = await createApp({ env, mailer });
  await UserModel.createIndexes(); // production gets this from migration 0005
}, 120_000);
afterAll(async () => { await ctx?.close?.(); await disconnectDb(); await mongo?.stop(); await rm(storage, { recursive: true, force: true }); });

describe('relying-party configuration', () => {
  it('is derived from PUBLIC_URL, and can be overridden', () => {
    expect(webauthnConfig(loadEnv({ NODE_ENV: 'test', PUBLIC_URL: 'https://pdf.example.com/' }))).toMatchObject({ rpID: 'pdf.example.com', origins: ['https://pdf.example.com'] });
    expect(webauthnConfig(loadEnv({ NODE_ENV: 'test', PUBLIC_URL: 'https://app.example.com', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com, https://www.example.com' })))
      .toMatchObject({ rpID: 'example.com', origins: ['https://app.example.com', 'https://www.example.com'] });
  });
});

describe('misconfiguration', () => {
  it('an invalid PUBLIC_URL makes the key endpoints answer 503 instead of crashing the API', async () => {
    const svc = new SecurityKeyService(loadEnv({ NODE_ENV: 'test', PUBLIC_URL: 'not a url' }), {} as never, {} as never);
    await expect(svc.loginOptions('x')).rejects.toMatchObject({ status: 503, code: 'not_configured' });
    await expect(svc.registrationOptions({} as never, 'pw')).rejects.toMatchObject({ status: 503, code: 'not_configured' });
  });
});

describe('registering a security key', () => {
  it('needs the password, and offers a fresh challenge each time', async () => {
    const u = await signup();
    expect((await regOptions(u.token, 'wrong password!')).status).toBe(403);
    expect((await request(ctx.app).post('/api/me/security-keys/options').send({ password: PW })).status).toBe(401);
    const a = await regOptions(u.token), b = await regOptions(u.token);
    expect(a.body.data.challenge).not.toBe(b.body.data.challenge);
    expect(a.body.data).toMatchObject({ rp: { id: 'localhost' }, attestation: 'none', authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' } });
    // the user handle is neither the database id nor the email
    const handle = Buffer.from(a.body.data.user.id, 'base64url').toString('latin1');
    expect(handle).not.toContain(u.id); expect(handle).not.toContain(u.email);
  });

  it('the first key turns two-step sign-in on: recovery codes once, a new session, every older session signed out', async () => {
    const u = await signup();
    const other = await login(u.email); // a second device
    const before = await request(ctx.app).get('/api/me').set(bearer(u.token));
    expect(before.body.data).toMatchObject({ twoFactorEnabled: false, totpEnabled: false, securityKeys: 0 });
    const key = new SoftKey();
    const r = await addKey(u, key, 'Desk key');
    expect(r.status).toBe(201);
    expect(r.body.data.recoveryCodes).toHaveLength(10);
    expect(r.body.data.user).toMatchObject({ twoFactorEnabled: true, totpEnabled: false, securityKeys: 1 });
    expect(r.body.data.keys).toEqual([expect.objectContaining({ id: key.id, name: 'Desk key', deviceType: 'singleDevice' })]);
    // older sessions are gone
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${u.refresh}`)).status).toBe(401);
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${refreshOf(other)}`)).status).toBe(401);
    // only public material and hashes are stored
    const stored = JSON.stringify((await dbUser(u.email))!.toObject());
    for (const c of r.body.data.recoveryCodes as string[]) expect(stored).not.toContain(c);
    expect(stored).not.toContain(key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  });

  it('refuses a response made for another site, another RP ID, another challenge, another ceremony, or without user presence', async () => {
    const u = await signup();
    const attempt = async (o: Parameters<SoftKey['create']>[1]) => {
      const opts = await regOptions(u.token);
      return request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response: new SoftKey().create(opts.body.data, o), name: 'k' });
    };
    for (const [label, o] of Object.entries({
      'wrong origin': { origin: 'https://evil.example' }, 'wrong rp id': { rpId: 'evil.example' }, 'wrong challenge': { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      'wrong ceremony': { type: 'webauthn.get' }, 'no user presence': { flags: 0x40 },
    })) {
      const r = await attempt(o);
      expect(r.status, label).toBe(400); expect(r.body.error.code, label).toBe('invalid_key');
    }
    expect((await request(ctx.app).get('/api/me').set(bearer(u.token))).body.data.securityKeys).toBe(0);
  });

  it('a response can be used once (replay) and only before the challenge expires', async () => {
    const u = await signup();
    const opts = await regOptions(u.token);
    const response = new SoftKey().create(opts.body.data);
    const post = () => request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response, name: 'k' });
    expect((await post()).status).toBe(201);
    const again = await post(); // the challenge was consumed
    expect(again.status).toBe(400); expect(again.body.error.code).toBe('no_pending_setup');
    // expiry
    const o2 = await regOptions(u.token);
    await UserModel.updateOne({ email: u.email }, { $set: { 'webauthnChallenge.expiresAt': new Date(Date.now() - 1000) } });
    const late = await request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response: new SoftKey().create(o2.body.data), name: 'k2' });
    expect(late.status).toBe(400); expect(late.body.error.code).toBe('no_pending_setup');
  });

  it('a registration challenge cannot be used to sign in, and a sign-in challenge cannot register a key', async () => {
    const u = await withKey();
    const challenge = await challengeFor(u.email);
    const opts = await loginOptions(challenge);
    // sign-in challenge is outstanding; try to use it for registration
    const r = await request(ctx.app).post('/api/me/security-keys').set(bearer(u.token)).send({ response: new SoftKey().create({ challenge: opts.body.data.challenge, rp: { id: 'localhost' } }), name: 'x' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('no_pending_setup');
  });

  it('a credential that belongs to one account cannot be registered to another', async () => {
    const a = await signup(), b = await signup();
    const key = new SoftKey();
    expect((await addKey(a, key)).status).toBe(201);
    const r = await addKey(b, key);
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('key_in_use');
  });

  it('the same key cannot be added twice to one account, and there is a limit of ten', async () => {
    const u = await signup();
    const first = new SoftKey();
    let t = u.token;
    const r1 = await addKey({ token: t }, first); t = r1.body.data.accessToken;
    // excludeCredentials lists the existing key
    const o = await regOptions(t);
    expect(o.body.data.excludeCredentials.map((c: { id: string }) => c.id)).toContain(first.id);
    for (let i = 0; i < 9; i++) expect((await addKey({ token: t }, new SoftKey())).status).toBe(201);
    const over = await regOptions(t);
    expect(over.status).toBe(409); expect(over.body.error.code).toBe('too_many_keys');
  });
});

describe('signing in with a key', () => {
  it('password, then the key: a session only after both; the challenge advertises what can be used', async () => {
    const u = await withKey();
    const pw = await login(u.email);
    expect(pw.body.data).toMatchObject({ twoFactorRequired: true, methods: { totp: false, securityKey: true } });
    expect(pw.body.data.accessToken).toBeUndefined(); expect(refreshOf(pw)).toBeUndefined();
    const opts = await loginOptions(pw.body.data.challenge);
    expect(opts.body.data.allowCredentials.map((c: { id: string }) => c.id)).toEqual([u.key.id]);
    expect(opts.body.data.userVerification).toBe('discouraged');
    const r = await loginKey(pw.body.data.challenge, u.key.get(opts.body.data));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy(); expect(refreshOf(r)).toBeTruthy();
    expect((await request(ctx.app).get('/api/me').set(bearer(r.body.data.accessToken))).body.data.email).toBe(u.email);
    const row = (await dbUser(u.email))!.securityKeys[0]!;
    expect(row.counter).toBe(u.key.counter); expect(row.lastUsedAt).toBeTruthy();
    expect(await AuditModel.countDocuments({ actor: `u:${u.id}`, action: 'auth.login', 'meta.via': 'security_key' })).toBe(1);
  });

  it('a wrong password never reaches the key step, and the key step needs a valid challenge', async () => {
    const u = await withKey();
    expect((await request(ctx.app).post('/api/auth/login').send({ email: u.email, password: 'nope-nope-nope' })).status).toBe(401);
    expect((await loginOptions('x'.repeat(30))).status).toBe(401);
    const opts = { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', rpId: 'localhost' };
    expect((await loginKey('x'.repeat(30), u.key.get(opts))).status).toBe(401);
    // an account without a key cannot ask for key options (it would not get a key challenge in the first place)
  });

  it('refuses answers made for another site, RP ID, challenge or ceremony, and answers without user presence', async () => {
    const u = await withKey();
    for (const [label, o] of Object.entries({
      'wrong origin': { origin: 'https://evil.example' }, 'wrong rp id': { rpId: 'evil.example' },
      'wrong challenge': { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'wrong ceremony': { type: 'webauthn.create' }, 'no user presence': { flags: 0x00 },
    })) {
      const r = await keySignIn(u.email, u.key, o);
      expect(r.status, label).toBe(401); expect(r.body.error.code, label).toBe('invalid_key');
      expect(r.body.data?.accessToken, label).toBeUndefined();
      await UserModel.updateOne({ email: u.email }, { $set: { 'twoFactor.failed': 0 } }); // keep each case clear of the lockout
    }
    // and the genuine key still works afterwards
    expect((await keySignIn(u.email, u.key)).status).toBe(200);
  });

  it('refuses a signature made by a different private key, and a credential that is not on the account', async () => {
    const u = await withKey();
    const forged = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const r1 = await keySignIn(u.email, u.key, { signWith: forged });
    expect(r1.status).toBe(401); expect(r1.body.error.code).toBe('invalid_key');
    const stranger = new SoftKey();
    const r2 = await keySignIn(u.email, stranger);
    expect(r2.status).toBe(401); expect(r2.body.error.code).toBe('invalid_key');
    // someone else's genuine key, offered on this account
    const other = await withKey();
    expect((await keySignIn(u.email, other.key)).status).toBe(401);
  });

  it('detects a cloned key: a counter that does not go up is refused, even with a valid signature', async () => {
    const u = await withKey();
    expect((await keySignIn(u.email, u.key)).status).toBe(200); // counter now 1
    expect((await keySignIn(u.email, u.key)).status).toBe(200); // 2
    const stale = await keySignIn(u.email, u.key, { counter: 2 }); // a clone replaying an old value
    expect(stale.status).toBe(401); expect(stale.body.error.code).toBe('invalid_key');
    const back = await keySignIn(u.email, u.key, { counter: 1 });
    expect(back.status).toBe(401);
    expect((await dbUser(u.email))!.securityKeys[0]!.counter).toBe(2); // unchanged by the refused attempts
    expect((await keySignIn(u.email, u.key, { counter: 3 })).status).toBe(200);
  });

  it('a captured response cannot be replayed, and a response without options is refused', async () => {
    const u = await withKey();
    const challenge = await challengeFor(u.email);
    const opts = await loginOptions(challenge);
    const resp = u.key.get(opts.body.data);
    expect((await loginKey(challenge, resp)).status).toBe(200);
    const replay = await loginKey(challenge, resp);
    expect(replay.status).toBe(401); expect(replay.body.error.code).toBe('invalid_challenge');
    const fresh = await challengeFor(u.email);
    const noOptions = await loginKey(fresh, u.key.get({ challenge: opts.body.data.challenge }));
    expect(noOptions.status).toBe(401); expect(noOptions.body.error.code).toBe('invalid_challenge');
  });

  it('two parallel uses of one valid response let exactly one in', async () => {
    const u = await withKey();
    const challenge = await challengeFor(u.email);
    const opts = await loginOptions(challenge);
    const resp = u.key.get(opts.body.data);
    const rs = await Promise.all([loginKey(challenge, resp), loginKey(challenge, resp), loginKey(challenge, resp)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('the challenge expires after five minutes', async () => {
    const u = await withKey();
    const challenge = await challengeFor(u.email);
    const opts = await loginOptions(challenge);
    await UserModel.updateOne({ email: u.email }, { $set: { 'webauthnChallenge.expiresAt': new Date(Date.now() - 1000) } });
    const r = await loginKey(challenge, u.key.get(opts.body.data));
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('invalid_challenge');
  });

  it('wrong keys count toward the same lockout as wrong passwords; a locked account refuses even the right key', async () => {
    const u = await withKey();
    for (let i = 0; i < 5; i++) expect((await keySignIn(u.email, new SoftKey())).status).toBe(401);
    const locked = await login(u.email);
    expect(locked.status).toBe(429);
    expect((await dbUser(u.email))!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await AuditModel.countDocuments({ actor: `u:${u.id}`, action: 'auth.2fa_failed' })).toBeGreaterThanOrEqual(5);
  });

  it('nothing secret is logged: no challenge, signature or public key in the audit trail', async () => {
    const u = await withKey();
    await keySignIn(u.email, u.key, { origin: 'https://evil.example' });
    await keySignIn(u.email, u.key);
    const text = JSON.stringify(await AuditModel.find({ actor: `u:${u.id}` }).lean());
    expect(text).not.toContain('signature'); expect(text).not.toContain('clientDataJSON'); expect(text).not.toMatch(/"challenge"/);
  });
});

describe('together with an authenticator app and recovery codes', () => {
  async function withBoth() {
    const u = await withKey();
    const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(u.token)).send({ password: PW });
    const secret = base32Decode(setup.body.data.secret);
    const en = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(u.token)).send({ code: totpAt(secret, Date.now()) });
    expect(en.status, JSON.stringify(en.body)).toBe(200);
    return { ...u, secret, token: en.body.data.accessToken as string, recovery: en.body.data.recoveryCodes as string[] };
  }

  it('offers both methods; the authenticator app still works', async () => {
    const u = await withBoth();
    const pw = await login(u.email);
    expect(pw.body.data.methods).toEqual({ totp: true, securityKey: true });
    const r = await request(ctx.app).post('/api/auth/login/2fa').send({ challenge: pw.body.data.challenge, code: totpAt(u.secret, Date.now() + 30_000) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('a recovery code signs in an account whose only factor is a lost key, once', async () => {
    const u = await withKey();
    const code = u.recovery[0]!;
    const pw1 = await login(u.email);
    expect((await request(ctx.app).post('/api/auth/login/2fa').send({ challenge: pw1.body.data.challenge, code })).status).toBe(200);
    const pw2 = await login(u.email);
    expect((await request(ctx.app).post('/api/auth/login/2fa').send({ challenge: pw2.body.data.challenge, code })).status).toBe(401);
    // a six-digit "authenticator code" is simply wrong for an account without an app
    const pw3 = await login(u.email);
    const r = await request(ctx.app).post('/api/auth/login/2fa').send({ challenge: pw3.body.data.challenge, code: '123456' });
    expect(r.status).toBe(401); expect(r.body.error.message).toMatch(/recovery code/);
  });

  it('turning the app off leaves the keys (and the recovery codes) protecting the account', async () => {
    const u = await withBoth();
    const off = await request(ctx.app).post('/api/me/2fa/disable').set(bearer(u.token)).send({ password: PW, code: u.recovery[0] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.user).toMatchObject({ twoFactorEnabled: true, totpEnabled: false, securityKeys: 1 });
    expect((await login(u.email)).body.data).toMatchObject({ twoFactorRequired: true, methods: { totp: false, securityKey: true } });
    expect((await dbUser(u.email))!.twoFactor.recoveryHashes.length).toBe(9);
  });

  it('regenerating recovery codes works for a keys-only account', async () => {
    const u = await withKey();
    const r = await request(ctx.app).post('/api/me/2fa/recovery-codes').set(bearer(u.token)).send({ password: PW, code: u.recovery[1] });
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.data.recoveryCodes).toHaveLength(10);
  });
});

describe('removing a key', () => {
  it('needs the password and a second factor; the last key with no app turns two-step sign-in off and discards the recovery codes', async () => {
    const u = await withKey();
    const url = `/api/me/security-keys/${u.key.id}`;
    const del = (body: object) => request(ctx.app).delete(url).set(bearer(u.token)).send(body);
    expect((await del({ password: 'wrong password', code: u.recovery[0] })).status).toBe(403);
    expect((await del({ password: PW, code: 'AAAAA-BBBBB' })).status).toBe(401);
    expect((await request(ctx.app).delete(url).set(bearer(u.token)).send({ password: PW })).status).toBe(400); // a second factor is required
    expect((await request(ctx.app).delete('/api/me/security-keys/unknown-id').set(bearer(u.token)).send({ password: PW, code: u.recovery[0] })).status).toBe(404);
    const ok = await del({ password: PW, code: u.recovery[0] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.keys).toEqual([]); expect(ok.body.data.user.twoFactorEnabled).toBe(false);
    expect((await dbUser(u.email))!.twoFactor?.recoveryHashes?.length ?? 0).toBe(0);
    expect((await login(u.email)).body.data.accessToken).toBeTruthy(); // no second step any more
    // the removed key no longer works anywhere
    expect((await dbUser(u.email))!.securityKeys).toHaveLength(0);
  });

  it('removing one of two keys keeps two-step sign-in on and signs other devices out', async () => {
    const u = await withKey();
    const second = new SoftKey();
    const add = await addKey({ token: u.token }, second, 'Spare');
    expect(add.status).toBe(201); expect(add.body.data.recoveryCodes).toBeUndefined(); // codes already exist: not replaced
    const sess = await keySignIn(u.email, u.key); // another device
    const r = await request(ctx.app).delete(`/api/me/security-keys/${u.key.id}`).set(bearer(u.token)).send({ password: PW, code: u.recovery[0] });
    expect(r.status).toBe(200); expect(r.body.data.user).toMatchObject({ twoFactorEnabled: true, securityKeys: 1 });
    expect((await request(ctx.app).post('/api/auth/refresh').set('X-PDFTools-CSRF', '1').set('Cookie', `pt_refresh=${refreshOf(sess)}`)).status).toBe(401);
    expect((await keySignIn(u.email, u.key)).status).toBe(401); // removed
    expect((await keySignIn(u.email, second)).status).toBe(200);
  });

  it("one person cannot remove another's key", async () => {
    const a = await withKey(), b = await withKey();
    const r = await request(ctx.app).delete(`/api/me/security-keys/${a.key.id}`).set(bearer(b.token)).send({ password: PW, code: b.recovery[0] });
    expect(r.status).toBe(404);
    expect((await dbUser(a.email))!.securityKeys).toHaveLength(1);
  });
});

describe('support and housekeeping', () => {
  it('an administrator reset also removes security keys (audited), and sessions end', async () => {
    const u = await withKey();
    const adminToken = (await request(ctx.app).post('/api/auth/login').send({ email: 'root@example.com', password: 'admin-password-123' })).body.data.accessToken as string;
    const r = await request(ctx.app).post(`/api/admin/users/${u.id}/2fa/reset`).set(bearer(adminToken));
    expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ twoFactorEnabled: false, securityKeys: 0 });
    expect((await login(u.email)).body.data.accessToken).toBeTruthy();
    expect(await SessionModel.countDocuments({ userId: u.id, revokedAt: { $exists: false } })).toBeGreaterThanOrEqual(1); // only the login just made
    expect(await AuditModel.countDocuments({ actor: `u:${u.id}`, action: 'auth.2fa_reset_by_admin' })).toBe(1);
  });

  it('every key endpoint requires sign-in (or a sign-in challenge)', async () => {
    for (const [m, p] of [['get', '/api/me/security-keys'], ['post', '/api/me/security-keys/options'], ['post', '/api/me/security-keys'], ['delete', '/api/me/security-keys/x']] as const) {
      expect((await request(ctx.app)[m](p).send({})).status, `${m} ${p}`).toBe(401);
    }
    expect((await request(ctx.app).post('/api/auth/login/2fa/key').send({})).status).toBe(400);
  });
});
