import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { hkdfSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { connectDb, disconnectDb, UserModel } from './db/models.js';
import { CaptureMailer } from './modules/mail/mailer.js';
import { twoFactorKeys } from './modules/auth/keyring.js';
import { SecretKeyError, base32Decode, keyId, openSecret, sealSecret, tryOpenSecret, totpAt } from './modules/auth/totp.js';
import { inspectTwoFactorKeys, rotateTwoFactorKeys } from './ops/rotate-two-factor.js';

const A = 'a'.repeat(16) + 'A'.repeat(16) + 'key-A-key-A-key-A';
const B = 'b'.repeat(16) + 'B'.repeat(16) + 'key-B-key-B-key-B';
const C = 'c'.repeat(16) + 'C'.repeat(16) + 'key-C-key-C-key-C';
const PW = 'correct horse battery';
const JWT = 'j'.repeat(40);

/** The format written before key ids existed, built independently of the production sealer. */
function sealV1(ikm: string, plain: Buffer): string {
  const key = Buffer.from(hkdfSync('sha256', ikm, 'pdftools', 'two-factor-secret-v1', 32));
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Change one bit of a base64url value. */
const flip = (b64: string) => { const b = Buffer.from(b64, 'base64url'); b[0] = b[0]! ^ 1; return b.toString('base64url'); };

describe('sealed secrets', () => {
  const plain = Buffer.from('0123456789abcdef0123');
  it('v2 values carry a key id, round-trip, and reveal nothing', () => {
    const s = sealSecret(A, plain);
    const [v, kid, iv, tag, ct] = s.split('.');
    expect(v).toBe('v2'); expect(kid).toBe(keyId(A)); expect(kid).not.toBe(keyId(B));
    expect([iv, tag, ct].every(Boolean)).toBe(true);
    expect(openSecret(A, s).equals(plain)).toBe(true);
    expect(s).not.toContain(plain.toString('base64url'));
    expect(sealSecret(A, plain)).not.toBe(s); // a fresh IV each time
  });
  it('only the right key opens it; the key id and every other part are authenticated', () => {
    const s = sealSecret(A, plain);
    expect(() => openSecret(B, s)).toThrow(SecretKeyError);
    expect(tryOpenSecret([B, C], s)).toBeNull();
    expect(tryOpenSecret([B, A], s)).toMatchObject({ keyIndex: 1, format: 'v2' });
    const p = s.split('.');
    for (const i of [2, 3, 4]) {
      const bad = [...p]; bad[i] = flip(bad[i]!);
      expect(tryOpenSecret([A], bad.join('.')), `part ${i}`).toBeNull();
    }
    const otherKid = [...p]; otherKid[1] = keyId(B);
    expect(tryOpenSecret([A, B], otherKid.join('.'))).toBeNull(); // claims key B, was sealed by A
  });
  it('legacy v1 values still open, with the current or an earlier key', () => {
    const old = sealV1(A, plain);
    expect(openSecret(A, old).equals(plain)).toBe(true);
    expect(tryOpenSecret([B, A], old)).toMatchObject({ keyIndex: 1, format: 'v1' });
    expect(tryOpenSecret([B, C], old)).toBeNull();
  });
  it('text that is not a sealed secret at all is an error, not a silent null', () => {
    for (const bad of ['', 'v3.a.b.c', 'v2.only.three', 'plain text']) expect(() => tryOpenSecret([A], bad), bad).toThrow(/unrecognised/);
  });
});

describe('the key ring', () => {
  const base = { DOWNLOAD_SECRET: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8', NODE_ENV: 'test' };
  it('current key first: TWO_FACTOR_KEY, else the JWT secret; earlier keys follow without duplicating the current one', () => {
    expect(twoFactorKeys(loadEnv({ ...base, JWT_ACCESS_SECRET: JWT, MONGODB_URI: 'mongodb://x' }))).toEqual([JWT]);
    expect(twoFactorKeys(loadEnv({ ...base, JWT_ACCESS_SECRET: JWT, TWO_FACTOR_KEY: B, TWO_FACTOR_KEY_PREVIOUS: `${A}, ${JWT} ,${B}`, MONGODB_URI: 'mongodb://x' }))).toEqual([B, A, JWT]);
  });
  it('rejects short or too many previous keys at start-up', () => {
    expect(() => loadEnv({ ...base, TWO_FACTOR_KEY_PREVIOUS: 'short' })).toThrow(/TWO_FACTOR_KEY_PREVIOUS/);
    expect(() => loadEnv({ ...base, TWO_FACTOR_KEY_PREVIOUS: [A, B, C, A + 'x'].join(',') })).toThrow(/TWO_FACTOR_KEY_PREVIOUS/);
    expect(loadEnv({ ...base }).TWO_FACTOR_KEY_PREVIOUS).toEqual([]);
  });
});

let mongo: MongoMemoryServer;
let n = 0;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await connectDb(mongo.getUri('pdftools')); }, 120_000);
afterAll(async () => { await disconnectDb(); await mongo?.stop(); });
afterEach(() => { vi.restoreAllMocks(); });

const mkUser = (fields: Record<string, unknown> = {}) => UserModel.create({ email: `r${n++}@example.com`, passwordHash: 'x', ...fields });
const secretOf = async (id: unknown, field = 'twoFactor') => ((await UserModel.findById(id).lean()) as never as Record<string, { secretEnc?: string }>)[field]?.secretEnc;
const raw = async (id: unknown) => JSON.stringify(await UserModel.findById(id).lean());
const P = (s: string) => Buffer.from(s.padEnd(20, '#'));

describe('rotating stored secrets', () => {
  it('re-seals everything that is not on the current key, leaves the rest exactly as it was, and reports what it cannot open', async () => {
    await UserModel.deleteMany({});
    const aV2 = await mkUser({ twoFactor: { secretEnc: sealSecret(A, P('aV2')), enabledAt: new Date(), lastStep: 7, recoveryHashes: ['h1', 'h2'], failed: 2 } });
    const aV1 = await mkUser({ twoFactor: { secretEnc: sealV1(A, P('aV1')), enabledAt: new Date() } });
    const bV2 = await mkUser({ twoFactor: { secretEnc: sealSecret(B, P('bV2')), enabledAt: new Date() } });
    const cV2 = await mkUser({ twoFactor: { secretEnc: sealSecret(C, P('cV2')), enabledAt: new Date() } });
    const pend = await mkUser({ twoFactorPending: { secretEnc: sealV1(A, P('pending')), createdAt: new Date() } });
    const none = await mkUser();
    const keysOnly = await mkUser({ securityKeys: [{ credentialId: 'x', publicKey: Buffer.from('k'), name: 'k' }] });
    const before = { bV2: await raw(bV2._id), cV2: await raw(cV2._id), none: await raw(none._id), keysOnly: await raw(keysOnly._id) };

    const status = await inspectTwoFactorKeys([B, A]);
    expect(status).toMatchObject({ secrets: 5, onCurrent: 1, needsRotation: 3, byFormat: { v1: 2, v2: 2 } });
    expect(status.byKey).toEqual({ current: 1, 'previous#1': 3, unknown: 1 });
    expect(status.undecryptable).toEqual([{ userId: String(cV2._id), field: 'twoFactor.secretEnc' }]);

    const aV2Before = await raw(aV2._id);
    const dry = await rotateTwoFactorKeys([B, A], { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, needsRotation: 3, rotated: 0 });
    expect(await raw(aV2._id)).toBe(aV2Before); // a dry run changes nothing

    const r = await rotateTwoFactorKeys([B, A]);
    expect(r).toMatchObject({ rotated: 3, raced: 0, dryRun: false });
    // every rotated secret now opens with the new key alone, to the same plaintext
    expect(openSecret([B], (await secretOf(aV2._id))!).equals(P('aV2'))).toBe(true);
    expect(openSecret([B], (await secretOf(aV1._id))!).equals(P('aV1'))).toBe(true);
    expect(openSecret([B], (await secretOf(pend._id, 'twoFactorPending'))!).equals(P('pending'))).toBe(true);
    expect((await secretOf(aV1._id))!.startsWith(`v2.${keyId(B)}.`)).toBe(true); // legacy format upgraded
    // nothing else about the account changed
    const after = (await UserModel.findById(aV2._id).lean())!;
    expect(after.twoFactor).toMatchObject({ lastStep: 7, recoveryHashes: ['h1', 'h2'], failed: 2 });
    // untouched accounts are byte-for-byte the same, including the one it could not open
    expect(await raw(bV2._id)).toBe(before.bV2); expect(await raw(cV2._id)).toBe(before.cV2);
    expect(await raw(none._id)).toBe(before.none); expect(await raw(keysOnly._id)).toBe(before.keysOnly);

    // finished: status is clean apart from the one that cannot be opened; a second run changes nothing
    expect(await rotateTwoFactorKeys([B, A])).toMatchObject({ rotated: 0, needsRotation: 0, onCurrent: 4 });
  });

  it('upgrades a legacy v1 value that is already under the current key (no key was ever rotated)', async () => {
    await UserModel.deleteMany({});
    const u = await mkUser({ twoFactor: { secretEnc: sealV1(B, P('legacy-current')), enabledAt: new Date() } });
    expect(await inspectTwoFactorKeys([B])).toMatchObject({ secrets: 1, onCurrent: 0, needsRotation: 1, byFormat: { v1: 1, v2: 0 }, byKey: { current: 1 } });
    expect(await rotateTwoFactorKeys([B])).toMatchObject({ rotated: 1 });
    expect((await secretOf(u._id))!.startsWith(`v2.${keyId(B)}.`)).toBe(true);
    expect(openSecret(B, (await secretOf(u._id))!).equals(P('legacy-current'))).toBe(true);
    expect(await inspectTwoFactorKeys([B])).toMatchObject({ onCurrent: 1, needsRotation: 0 });
  });

  it('visits every secret exactly once however it is batched', async () => {
    await UserModel.deleteMany({});
    for (let i = 0; i < 7; i++) await mkUser({ twoFactor: { secretEnc: sealSecret(A, P(`u${i}`)), enabledAt: new Date() } });
    const r = await rotateTwoFactorKeys([B, A], { batchSize: 2 });
    expect(r).toMatchObject({ secrets: 7, rotated: 7 });
    expect(await rotateTwoFactorKeys([B, A], { batchSize: 3 })).toMatchObject({ secrets: 7, rotated: 0, onCurrent: 7 });
  });

  it('does not overwrite a value that changed while it was working (compare-and-set), and a second run picks it up', async () => {
    await UserModel.deleteMany({});
    const u = await mkUser({ twoFactor: { secretEnc: sealSecret(A, P('old')), enabledAt: new Date() } });
    const replacement = sealSecret(A, P('redone-setup'));
    const real = UserModel.updateOne.bind(UserModel) as (...a: unknown[]) => Promise<unknown>;
    let first = true;
    vi.spyOn(UserModel, 'updateOne').mockImplementation(((...args: unknown[]) => {
      if (first) { first = false; return real({ _id: u._id }, { $set: { 'twoFactor.secretEnc': replacement } }).then(() => real(...args)); }
      return real(...args);
    }) as never);
    const r = await rotateTwoFactorKeys([B, A]);
    expect(r).toMatchObject({ rotated: 0, raced: 1 });
    expect(await secretOf(u._id)).toBe(replacement); // the newer value survived
    vi.restoreAllMocks();
    expect(await rotateTwoFactorKeys([B, A])).toMatchObject({ rotated: 1, raced: 0 });
    expect(openSecret([B], (await secretOf(u._id))!).equals(P('redone-setup'))).toBe(true);
  });

  it('the report never contains key material, plaintext or ciphertext', async () => {
    await UserModel.deleteMany({});
    const sealed = sealSecret(A, P('visible?'));
    await mkUser({ twoFactor: { secretEnc: sealed, enabledAt: new Date() } });
    await mkUser({ twoFactor: { secretEnc: sealSecret(C, P('lost')), enabledAt: new Date() } });
    const text = JSON.stringify([await inspectTwoFactorKeys([B, A]), await rotateTwoFactorKeys([B, A])]);
    for (const secret of [A, B, C, sealed, P('visible?').toString('base64url'), P('visible?').toString('latin1')]) expect(text).not.toContain(secret);
  });
});

describe('sign-in across key changes (real HTTP stack)', () => {
  let storage: string;
  const mailer = new CaptureMailer();
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const app = async (extra: Record<string, string>) => {
    const env = loadEnv({ NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), RATE_LIMIT_ENABLED: 'false', JWT_ACCESS_SECRET: JWT, ...extra });
    return createApp({ env, mailer });
  };
  afterEach(() => { vi.useRealTimers(); });
  /** Codes must move forward in time (replay protection), so each use gets a later frozen clock. */
  const codeAt = (secret: Buffer, steps: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + steps * 30_000); return totpAt(secret, Date.now()); };

  it('old secrets keep working through a rotation, and the whole cycle ends with only the new key', async () => {
    storage = await mkdtemp(join(tmpdir(), 'rot-'));
    await UserModel.deleteMany({}); // earlier tests left deliberately unopenable secrets behind
    const email = `rot${n++}@example.com`;
    let secret!: Buffer, recovery!: string[], userId!: string;

    // 1) running on key A: the user turns on an authenticator app
    let ctx = await app({ TWO_FACTOR_KEY: A });
    const reg = await request(ctx.app).post('/api/auth/register').send({ email, password: PW, name: 'T' });
    userId = reg.body.data.user.id;
    const setup = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(reg.body.data.accessToken)).send({ password: PW });
    secret = base32Decode(setup.body.data.secret);
    const en = await request(ctx.app).post('/api/me/2fa/enable').set(bearer(reg.body.data.accessToken)).send({ code: totpAt(secret, Date.now()) });
    expect(en.status).toBe(200); recovery = en.body.data.recoveryCodes;
    expect((await secretOf(userId))!.startsWith(`v2.${keyId(A)}.`)).toBe(true);
    await ctx.close?.();

    const signIn = async (c: typeof ctx, code: string) => {
      const pw = await request(c.app).post('/api/auth/login').send({ email, password: PW });
      return request(c.app).post('/api/auth/login/2fa').send({ challenge: pw.body.data.challenge, code });
    };

    // 2) deploy with the new key B and A as previous: the same app keeps working, with no tool run yet
    ctx = await app({ TWO_FACTOR_KEY: B, TWO_FACTOR_KEY_PREVIOUS: A });
    expect((await signIn(ctx, codeAt(secret, 1))).status).toBe(200);
    expect((await secretOf(userId))!.startsWith(`v2.${keyId(A)}.`)).toBe(true); // reading does not rewrite; the tool does
    // a new setup is sealed with the new key straight away
    const other = await request(ctx.app).post('/api/auth/register').send({ email: `rot${n++}@example.com`, password: PW, name: 'T' });
    const s2 = await request(ctx.app).post('/api/me/2fa/setup').set(bearer(other.body.data.accessToken)).send({ password: PW });
    expect((await request(ctx.app).post('/api/me/2fa/enable').set(bearer(other.body.data.accessToken)).send({ code: totpAt(base32Decode(s2.body.data.secret), Date.now()) })).status).toBe(200);
    expect((await secretOf(other.body.data.user.id))!.startsWith(`v2.${keyId(B)}.`)).toBe(true);
    // 3) the tool runs
    const done = await rotateTwoFactorKeys(twoFactorKeys(loadEnv({ NODE_ENV: 'test', TWO_FACTOR_KEY: B, TWO_FACTOR_KEY_PREVIOUS: A, JWT_ACCESS_SECRET: JWT })));
    expect(done).toMatchObject({ rotated: 1, raced: 0 }); expect(done.undecryptable).toEqual([]);
    await ctx.close?.();

    // 4) A is removed: still works
    ctx = await app({ TWO_FACTOR_KEY: B });
    expect((await signIn(ctx, codeAt(secret, 2))).status).toBe(200);
    await ctx.close?.();

    // 5) the key was lost entirely: a clear 503 for that account (not a wrong-code error, not a lockout), recovery codes still work
    ctx = await app({ TWO_FACTOR_KEY: C });
    const lost = await signIn(ctx, codeAt(secret, 3));
    expect(lost.status).toBe(503); expect(lost.body.error.code).toBe('two_factor_unavailable');
    expect((await UserModel.findById(userId).lean())!.twoFactor!.failed).toBe(0);
    expect((await UserModel.findById(userId).lean())!.lockedUntil).toBeFalsy();
    expect((await signIn(ctx, recovery[0]!)).status).toBe(200);
    await ctx.close?.();
    await rm(storage, { recursive: true, force: true });
  }, 120_000);
});

describe('the rotate-2fa command', () => {
  const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/rotate2fa.ts', ...args], { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env }, cwd: process.cwd() });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });

  it('status, dry run and run behave, exit with the right codes, and never print a key', async () => {
    await UserModel.deleteMany({});
    await mkUser({ twoFactor: { secretEnc: sealV1(A, P('cli1')), enabledAt: new Date() } });
    await mkUser({ twoFactor: { secretEnc: sealSecret(A, P('cli2')), enabledAt: new Date() } });
    const lost = await mkUser({ twoFactor: { secretEnc: sealSecret(C, P('lost')), enabledAt: new Date() } });
    const env = { MONGODB_URI: mongo.getUri('pdftools'), JWT_ACCESS_SECRET: JWT, TWO_FACTOR_KEY: B, TWO_FACTOR_KEY_PREVIOUS: A };
    const noKeys = (out: string) => [A, B, C, JWT].every((k) => !out.includes(k));

    const st = await run(['status'], env);
    expect(st.code).toBe(1); expect(st.out).toMatch(/authenticator secrets: 3/); expect(st.out).toMatch(/previous#1\s+2/); expect(st.out).toContain(String(lost._id)); expect(noKeys(st.out)).toBe(true);
    const dry = await run(['run', '--dry-run'], env);
    expect(dry.out).toMatch(/2 would be re-sealed, nothing was changed/); expect(noKeys(dry.out)).toBe(true);
    expect((await inspectTwoFactorKeys([B, A])).needsRotation).toBe(2);
    const lostBefore = await secretOf(lost._id);
    const go = await run(['run'], env);
    expect(go.code).toBe(1); // one secret cannot be opened: the exit code says so even though two were fixed
    expect(go.out).toMatch(/re-sealed: 2/); expect(go.out).toMatch(/CANNOT BE OPENED/); expect(noKeys(go.out)).toBe(true);
    expect(await secretOf(lost._id)).toBe(lostBefore); // the one it cannot open is left exactly as it was
    // with the lost key supplied the rest of the way, it finishes cleanly
    const fixed = await run(['run'], { ...env, TWO_FACTOR_KEY_PREVIOUS: `${A},${C}` });
    expect(fixed.code).toBe(0); expect(fixed.out).toMatch(/re-sealed: 1/);
    const clean = await run(['status'], { ...env, TWO_FACTOR_KEY_PREVIOUS: '' });
    expect(clean.code).toBe(0); expect(clean.out).toMatch(/already on the current key: 3/);
  }, 120_000);

  it('refuses without arguments, or without a database, with exit code 2', async () => {
    expect((await run([], { MONGODB_URI: mongo.getUri('pdftools'), JWT_ACCESS_SECRET: JWT })).code).toBe(2);
    expect((await run(['bogus'], {})).code).toBe(2);
    const noDb = await run(['status'], { JWT_ACCESS_SECRET: JWT });
    expect(noDb.code).toBe(2); expect(noDb.out).toMatch(/MONGODB_URI/);
  }, 60_000);
});
