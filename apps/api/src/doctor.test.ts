import { describe, it, expect } from 'vitest';
import { loadEnv } from './config/env.js';
import { checkConfig, runDoctor } from './ops/doctor.js';

const JWT = 'k3J9fd8Q2mZ7vB1nX5cL0aW4sD6gH8jR';
const GOOD = { NODE_ENV: 'production', DOWNLOAD_SECRET: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8', PUBLIC_URL: 'https://pdf.example.com', CORS_ORIGINS: 'https://pdf.example.com', TRUST_PROXY: '1', METRICS_TOKEN: 'metrics-token-1234567', SMTP_URL: 'smtps://u:p@smtp.example.com' };
const by = (checks: ReturnType<typeof checkConfig>, name: string) => checks.find((c) => c.name === name)!;

describe('doctor: production configuration review', () => {
  it('passes a sound production config', () => {
    const c = checkConfig(loadEnv(GOOD));
    expect(c.filter((x) => x.level === 'fail')).toEqual([]);
    expect(c.filter((x) => x.level === 'warn')).toEqual([]);
  });
  it('fails on each dangerous setting, with an explanation', () => {
    const bad = checkConfig(loadEnv({ ...GOOD, PUBLIC_URL: 'http://pdf.example.com', CORS_ORIGINS: 'http://pdf.example.com,https://ok.example.com', RATE_LIMIT_ENABLED: 'false', ISOLATE_JOBS: 'false' }));
    for (const n of ['public url is https', 'cors origins', 'rate limiting', 'job isolation']) expect(by(bad, n).level, n).toBe('fail');
  });
  it('flags a missing or placeholder secret', () => {
    expect(by(checkConfig(loadEnv({ ...GOOD, DOWNLOAD_SECRET: 'x'.repeat(40) })), 'download secret').level).toBe('fail');
    const gen = checkConfig(loadEnv({ NODE_ENV: 'development' }));
    expect(by(gen, 'download secret').level).toBe('warn'); // advisory outside production
    expect(by(gen, 'download secret').detail).toMatch(/random per start/);
    expect(by(checkConfig(loadEnv({ ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: 'x'.repeat(40) })), 'jwt secret').level).toBe('fail'); // placeholder-looking
    expect(by(checkConfig(loadEnv({ ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: 'k3J9fd8Q2mZ7vB1nX5cL0aW4sD6gH8jR' })), 'jwt secret').level).toBe('pass');
    expect(() => loadEnv({ ...GOOD, MONGODB_URI: 'mongodb://x' })).toThrow(/JWT_ACCESS_SECRET/); // and production refuses to even load without one
  });
  it('with accounts on, warns about the two-factor key and unverified checkout, and is quiet once both are set', () => {
    const accounts = { ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT };
    const warn = checkConfig(loadEnv(accounts));
    expect(by(warn, 'two-factor key').level).toBe('warn');
    expect(by(warn, 'two-factor key').detail).toMatch(/rotating/);
    expect(by(warn, 'verified email for checkout').level).toBe('warn');
    const ok = checkConfig(loadEnv({ ...accounts, TWO_FACTOR_KEY: 'f'.repeat(40), REQUIRE_VERIFIED_EMAIL: 'true' }));
    expect(by(ok, 'two-factor key').level).toBe('pass');
    expect(by(ok, 'verified email for checkout').level).toBe('pass');
    expect(() => loadEnv({ ...accounts, TWO_FACTOR_KEY: 'too short' })).toThrow(/TWO_FACTOR_KEY/);
  });
  it('reviews the security-key settings: https origin, RP ID that matches the host, and explains what breaks', () => {
    const accounts = { ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT };
    const name = 'security keys (WebAuthn)';
    expect(by(checkConfig(loadEnv(accounts)), name)).toMatchObject({ level: 'pass', detail: expect.stringContaining('RP ID pdf.example.com') });
    expect(by(checkConfig(loadEnv({ ...accounts, WEBAUTHN_RP_ID: 'example.com' })), name).level).toBe('pass'); // a parent domain is fine
    const wrongRp = by(checkConfig(loadEnv({ ...accounts, WEBAUTHN_RP_ID: 'other.example' })), name);
    expect(wrongRp.level).toBe('fail'); expect(wrongRp.detail).toMatch(/never be used/);
    const http = by(checkConfig(loadEnv({ ...accounts, WEBAUTHN_ORIGINS: 'http://pdf.example.com' })), name);
    expect(http.level).toBe('fail'); expect(http.detail).toMatch(/not https/);
    expect(by(checkConfig(loadEnv({ ...accounts, NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:5173', CORS_ORIGINS: 'http://localhost:5173' })), name).level).toBe('pass'); // localhost is exempt
    expect(by(checkConfig(loadEnv({ ...accounts, NODE_ENV: 'development', PUBLIC_URL: 'http://pdf.example.com' })), name).level).toBe('warn'); // advisory outside production
    expect(by(checkConfig(loadEnv({ ...accounts, NODE_ENV: 'development', PUBLIC_URL: 'not a url' })), name).level).toBe('fail');
  });
  it('reports the administrator two-step policy: required passes, an explicit off in production warns', () => {
    const accounts = { ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT };
    expect(by(checkConfig(loadEnv(accounts)), 'admin two-step sign-in')).toMatchObject({ level: 'pass', detail: expect.stringContaining('required') });
    const off = by(checkConfig(loadEnv({ ...accounts, REQUIRE_ADMIN_2FA: 'false' })), 'admin two-step sign-in');
    expect(off.level).toBe('warn'); expect(off.detail).toMatch(/just a password/);
    expect(by(checkConfig(loadEnv({ ...accounts, NODE_ENV: 'development' })), 'admin two-step sign-in').level).toBe('pass'); // off by default outside production
  });
  it('reviews team billing: flat passes quietly, per-seat needs Stripe and sane limits, a Stripe test double is flagged', () => {
    const accounts = { ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT };
    const stripe = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_PRICE_PRO: 'price_x' };
    expect(by(checkConfig(loadEnv(accounts)), 'team billing')).toMatchObject({ level: 'pass', detail: expect.stringContaining('flat') });
    expect(by(checkConfig(loadEnv({ ...accounts, ...stripe, TEAM_BILLING: 'per_seat' })), 'team billing')).toMatchObject({ level: 'pass', detail: expect.stringMatching(/per seat \(2 to 100 seats\).*Stripe price.*once per seat/) });
    const noStripe = by(checkConfig(loadEnv({ ...accounts, TEAM_BILLING: 'per_seat' })), 'team billing');
    expect(noStripe.level).toBe('warn'); expect(noStripe.detail).toMatch(/no payment gateway is configured/);
    // Razorpay alone is enough to sell per-seat teams
    const rz = { RAZORPAY_KEY_ID: 'rzp_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'whsec_rz_x' };
    expect(by(checkConfig(loadEnv({ ...accounts, ...rz, TEAM_BILLING: 'per_seat' })), 'team billing')).toMatchObject({ level: 'pass', detail: expect.stringMatching(/Razorpay plan.*once per seat/) });
    const bad = by(checkConfig(loadEnv({ ...accounts, ...stripe, TEAM_BILLING: 'per_seat', TEAM_MIN_SEATS: '30', TEAM_MAX_SEATS: '10' })), 'team billing');
    expect(bad.level).toBe('fail'); expect(bad.detail).toMatch(/no seat count would be valid/);
    expect(() => loadEnv({ ...accounts, TEAM_BILLING: 'monthly' })).toThrow(/TEAM_BILLING/);
    // pointing Stripe elsewhere is for tests only
    expect(checkConfig(loadEnv({ ...accounts, ...stripe })).find((c) => c.name === 'stripe api base')).toBeUndefined();
    expect(by(checkConfig(loadEnv({ ...accounts, ...stripe, STRIPE_API_BASE: 'http://localhost:12111' })), 'stripe api base').level).toBe('fail'); // in production
    expect(by(checkConfig(loadEnv({ ...accounts, ...stripe, NODE_ENV: 'development', STRIPE_API_BASE: 'http://localhost:12111' })), 'stripe api base').level).toBe('warn');
  });
  it('Razorpay: needs key id, key secret and webhook secret together; a test double is flagged', () => {
    const accounts = { ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT };
    const rz = { RAZORPAY_KEY_ID: 'rzp_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'whsec_rz_x' };
    expect(by(checkConfig(loadEnv({ ...accounts, ...rz, RAZORPAY_PLAN_PRO: 'plan_x' })), 'billing')).toMatchObject({ level: 'pass', detail: 'Razorpay configured' });
    expect(by(checkConfig(loadEnv({ ...accounts, ...rz })), 'razorpay plans').level).toBe('warn');
    for (const missing of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
      const partial = { ...rz, [missing]: '' };
      expect(by(checkConfig(loadEnv({ ...accounts, ...partial })), 'billing'), missing).toMatchObject({ level: 'fail', detail: expect.stringContaining('must all be set together') });
    }
    expect(by(checkConfig(loadEnv({ ...accounts, ...rz, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })), 'billing').detail).toBe('Stripe and Razorpay configured');
    expect(by(checkConfig(loadEnv({ ...accounts, ...rz, RAZORPAY_API_BASE: 'http://localhost:9' })), 'razorpay api base').level).toBe('fail'); // production
    expect(checkConfig(loadEnv({ ...accounts, ...rz })).find((c) => c.name === 'razorpay api base')).toBeUndefined();
  });
  it('requires Stripe key and webhook secret together; warns about leftovers', () => {
    expect(by(checkConfig(loadEnv({ ...GOOD, STRIPE_SECRET_KEY: 'sk_test_x' })), 'billing').level).toBe('fail');
    expect(by(checkConfig(loadEnv({ ...GOOD, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' })), 'billing').level).toBe('pass');
    const left = checkConfig(loadEnv({ ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT, ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'long-admin-password' }));
    expect(by(left, 'bootstrap admin').level).toBe('warn');
    expect(by(checkConfig(loadEnv({ ...GOOD, MONGODB_URI: 'mongodb://x', JWT_ACCESS_SECRET: JWT, SMTP_URL: '' })), 'email delivery').level).toBe('warn');
  });
  it('warns when a proxy is likely but TRUST_PROXY is 0', () => {
    expect(by(checkConfig(loadEnv({ ...GOOD, TRUST_PROXY: '0' })), 'reverse proxy trust').level).toBe('warn');
  });
});

describe('doctor: live checks on this machine', () => {
  it('verifies engines, proves the kernel enforces memory limits, and checks storage', async () => {
    const r = await runDoctor(loadEnv({ NODE_ENV: 'development', STORAGE_DIR: '/tmp/doctor-test-storage' }));
    const get = (n: string) => r.checks.find((c) => c.name === n)!;
    for (const bin of ['gs', 'pdftoppm', 'soffice', 'prlimit', 'convert']) expect(get(`engine: ${bin}`).level, bin).toBe('pass');
    expect(get('kernel memory limits').level).toBe('pass');
    expect(get('storage writable').level).toBe('pass');
    expect(r.ok).toBe(true);
  }, 90_000);
  it('reports unreachable dependencies as failures instead of throwing', async () => {
    const r = await runDoctor(loadEnv({ NODE_ENV: 'development', STORAGE_DIR: '/tmp/doctor-test-storage', QUEUE_DRIVER: 'bullmq', REDIS_URL: 'redis://127.0.0.1:1', MONGODB_URI: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=500' }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'redis')!.level).toBe('fail');
    expect(r.checks.find((c) => c.name === 'mongodb')!.level).toBe('fail');
  }, 90_000);
});
