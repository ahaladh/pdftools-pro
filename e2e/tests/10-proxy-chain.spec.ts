import { test, expect, request as pwRequest } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { makePdf } from '../support/helpers';
import { ROOT, readState } from '../support/stack';
import { CADDY, NGINX, startChain, type Chain } from '../support/edge';

/**
 * The docker-compose TLS chain exactly as shipped: Caddy -> nginx (container config) -> production API.
 * The questions that matter here are the ones a chain of proxies gets wrong: is the real client IP preserved, is a spoofed
 * X-Forwarded-For ignored, does each client get its OWN rate-limit bucket, and is every header set exactly once?
 */
test.skip((!NGINX || !CADDY) && !process.env.CI, 'nginx and caddy not available: set NGINX_BIN / CADDY_BIN');
test.describe.configure({ mode: 'serial' });
test.use({ ignoreHTTPSErrors: true });

const API_PORT = 4204, NGINX_PORT = 4570, CADDY_PORT = 4555;
let chain: Chain, api: ChildProcess;
async function until(fn: () => Promise<boolean>, ms = 40_000) { const end = Date.now() + ms; let last = ''; while (Date.now() < end) { try { if (await fn()) return; last = 'returned false'; } catch (e) { last = String((e as Error).message); } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`timed out (last: ${last})`); }

/** One request from a chosen SOURCE address (127.0.0.1 or 127.0.0.2): lets a single machine impersonate two different clients. */
function fromAddress(localAddress: string, path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: CADDY_PORT, servername: 'localhost', path, method: opts.method ?? 'GET', localAddress, rejectUnauthorized: false, headers: { Host: `localhost:${CADDY_PORT}`, ...opts.headers } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers })); });
    req.on('error', reject); req.end(opts.body);
  });
}

test.beforeAll(async () => {
  const s = readState();
  const env = { ...s.env, NODE_ENV: 'production', PORT: String(API_PORT), TRUST_PROXY: '1', METRICS_TOKEN: randomBytes(12).toString('hex'), PUBLIC_URL: `https://localhost:${CADDY_PORT}`, CORS_ORIGINS: `https://localhost:${CADDY_PORT}`,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), DOWNLOAD_SECRET: randomBytes(32).toString('hex'), SMTP_URL: 'smtp://127.0.0.1:1', RATE_LIMIT_ENABLED: 'false', DAILY_OPS_GUEST: '1000' } as Record<string, string>;
  delete env.ADMIN_EMAIL; delete env.ADMIN_PASSWORD;
  api = spawn(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], { cwd: join(ROOT, 'apps/api'), env: { ...env, PATH: process.env.PATH! }, stdio: 'ignore', detached: true });
  await until(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok);
  chain = startChain({ apiAddr: `127.0.0.1:${API_PORT}`, nginxPort: NGINX_PORT, caddyPort: CADDY_PORT });
  await until(async () => (await fetch(`http://127.0.0.1:${NGINX_PORT}/healthz`)).ok);
  await until(async () => (await fromAddress('127.0.0.1', '/healthz')).status === 200, 60_000); // Caddy needs a moment to mint its local certificate
});
test.afterAll(() => { chain?.stop(); try { process.kill(-api.pid!, 'SIGTERM'); } catch { /* gone */ } });

test('the whole chain serves the prerendered site over HTTPS, and every security header appears exactly once', async () => {
  const http = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  for (const path of ['/', '/merge', '/api/config', '/healthz']) {
    const r = await http.get(chain.httpsUrl + path);
    expect(r.status(), path).toBe(200);
    const names = r.headersArray().map((h) => h.name.toLowerCase());
    for (const h of ['strict-transport-security', 'x-content-type-options', 'content-security-policy', 'x-frame-options', 'referrer-policy']) {
      expect(names.filter((n) => n === h).length, `${path}: ${h} must not be duplicated`).toBeLessThanOrEqual(1);
    }
    expect(names.filter((n) => n === 'strict-transport-security').length, `${path} HSTS`).toBe(1);
    expect(r.headers()['strict-transport-security']).toContain('max-age=63072000');
    expect(r.headers()['server'] ?? '').not.toMatch(/\d/); // no version numbers
  }
  expect(await (await http.get(chain.httpsUrl + '/merge')).text()).toContain('<h1'); // prerendered content survived both proxies
  await http.dispose();
});

test('the real client IP reaches the API through two proxies, and a spoofed X-Forwarded-For is overwritten', async () => {
  const http = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  const r = await http.post(chain.httpsUrl + '/api/pdf/rotate', { multipart: { files: { name: 'a.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) }, options: '{"angle":90}' }, headers: { 'X-Forwarded-For': '203.0.113.77, 198.51.100.9' } });
  expect(r.status()).toBe(202);
  const id = (await r.json()).data.jobId as string;
  await until(async () => (await (await http.get(`${chain.httpsUrl}/api/jobs/${id}`)).json()).data.state === 'completed');
  await mongoose.connect(readState().env.MONGODB_URI!);
  try {
    const keys = (await mongoose.connection.collection('usages').find({ key: /^ip:/ }).toArray()).map((u) => u.key as string);
    expect(keys.some((k) => k.includes('203.0.113.77') || k.includes('198.51.100.9'))).toBe(false);
    expect(keys.some((k) => /127\.0\.0\.1|::1/.test(k))).toBe(true);
  } finally { await mongoose.disconnect(); }
  await http.dispose();
});

test('rate limits are per REAL client: one client exhausting its bucket does not throttle another', async () => {
  const codesA: number[] = [];
  for (let i = 0; i < 60; i++) codesA.push((await fromAddress('127.0.0.1', '/api/auth/login', { method: 'POST', body: '{"email":"x@example.com","password":"y"}', headers: { 'Content-Type': 'application/json' } })).status);
  expect(codesA.filter((c) => c === 429).length).toBeGreaterThan(10);   // client A hit the edge limit
  const b = await fromAddress('127.0.0.2', '/api/auth/login', { method: 'POST', body: '{"email":"x@example.com","password":"y"}', headers: { 'Content-Type': 'application/json' } });
  expect(b.status).not.toBe(429);                                       // client B has its own, untouched bucket
  expect([400, 401]).toContain(b.status);
});

test('large uploads stream through both proxies, and the API\'s own limit error comes back intact', async () => {
  const http = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  // A real PDF with ~15 MB of trailing bytes is still a valid PDF for the type check, but fails parsing: what matters is that the API answers.
  const ok = await http.post(chain.httpsUrl + '/api/pdf/rotate', { multipart: { files: { name: 'big.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([await makePdf(1), Buffer.alloc(15 * 1024 * 1024)]) }, options: '{"angle":90}' } });
  expect(ok.status()).toBe(202);
  const tooBig = await http.post(chain.httpsUrl + '/api/pdf/rotate', { multipart: { files: { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([await makePdf(1), Buffer.alloc(30 * 1024 * 1024)]) }, options: '{"angle":90}' } });
  expect(tooBig.status()).toBe(413);
  expect((await tooBig.json()).error.code).toBe('file_too_large'); // the API's JSON envelope, not a proxy error page
  await http.dispose();
});
