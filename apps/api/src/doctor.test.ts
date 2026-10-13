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
