import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { PDFDocument } from '@cantoo/pdf-lib';
import { file, makePdf, watchConsole } from '../support/helpers';
import { ROOT, readState } from '../support/stack';
import { NGINX, startEdge, type Edge } from '../support/edge';

/**
 * The production topology end to end: real nginx (rendered from infrastructure/nginx), real TLS, a NODE_ENV=production API,
 * the separate worker, MongoDB and Redis. Everything here is about behaviour that only exists in production.
 */
test.skip(!NGINX && !process.env.CI, 'nginx not available: set NGINX_BIN (CI installs it)');
test.describe.configure({ mode: 'serial' });
test.use({ ignoreHTTPSErrors: true });

const API_PORT = 4202, HTTP_PORT = 4480, HTTPS_PORT = 4443;
const METRICS_TOKEN = randomBytes(12).toString('hex');
let edge: Edge, api: ChildProcess, apiLogs = '';
let http: APIRequestContext;

async function until(fn: () => Promise<boolean>, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error('timed out'); }

test.beforeAll(async () => {
  const s = readState();
  const env = {
    ...s.env, NODE_ENV: 'production', PORT: String(API_PORT), TRUST_PROXY: '1', METRICS_TOKEN,
    PUBLIC_URL: `https://localhost:${HTTPS_PORT}`, CORS_ORIGINS: `https://localhost:${HTTPS_PORT}`,
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), DOWNLOAD_SECRET: randomBytes(32).toString('hex'),
    SMTP_URL: 'smtp://127.0.0.1:1', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX_PER_WINDOW: '100000', LOG_LEVEL: 'info',
  } as Record<string, string>;
  delete env.ADMIN_EMAIL; delete env.ADMIN_PASSWORD;
  api = spawn(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], { cwd: join(ROOT, 'apps/api'), env: { ...env, PATH: process.env.PATH! }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  api.stdout!.on('data', (d: Buffer) => { apiLogs += d.toString(); }); api.stderr!.on('data', (d: Buffer) => { apiLogs += d.toString(); });
  await until(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok);
  edge = startEdge({ apiAddr: `127.0.0.1:${API_PORT}`, httpPort: HTTP_PORT, httpsPort: HTTPS_PORT });
  await until(async () => (await fetch(`http://localhost:${HTTP_PORT}/`, { redirect: 'manual' })).status === 301).catch((e: Error) => {
    // Say WHY nginx did not come up (bad directive for this nginx version, port in use...) instead of just "timed out".
    let log = ''; try { log = readFileSync(edge.errorLog, 'utf8').split('\n').slice(-15).join('\n'); } catch { /* none */ }
    throw new Error(`${e.message}\n--- nginx -t:\n${edge.test()}\n--- error.log (tail):\n${log}`);
  });
  http = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: edge.httpsUrl });
});
test.afterAll(async () => { await http?.dispose(); edge?.stop(); try { process.kill(-api.pid!, 'SIGTERM'); } catch { /* gone */ } });

test.describe('edge configuration', () => {
  test('nginx accepts the rendered production config (paths with spaces included)', () => {
    expect(edge.test()).toBe('ok');
    // The template must quote its paths. Prove it with a web root that contains spaces, wherever the repo itself happens to live.
    const spaced = join(mkdtempSync(join(tmpdir(), 'edge dir with spaces-')), 'web root');
    symlinkSync(join(ROOT, 'apps/web/dist'), spaced);
    const other = startEdge({ apiAddr: `127.0.0.1:${API_PORT}`, httpPort: HTTP_PORT + 100, httpsPort: HTTPS_PORT + 100, webRoot: spaced });
    try { expect(spaced).toContain(' '); expect(readFileSync(other.conf, 'utf8')).toContain(`root "${spaced}"`); expect(other.test()).toBe('ok'); }
    finally { other.stop(); }
  });

  test('plain HTTP redirects to HTTPS (permanent) without serving content, except ACME challenges', async () => {
    const r = await fetch(`http://localhost:${HTTP_PORT}/merge?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`https://localhost/merge?x=1`.replace('https://localhost', 'https://localhost'));
    expect(await r.text()).not.toContain('<div id="root">');
    const acme = await fetch(`http://localhost:${HTTP_PORT}/.well-known/acme-challenge/x`, { redirect: 'manual' });
    expect(acme.status).toBe(404); // served from the (empty) webroot rather than redirected
  });

  test('TLS: modern protocols only', () => {
    const probe = (flag: string) => { try { execFileSync('openssl', ['s_client', '-connect', `localhost:${HTTPS_PORT}`, flag, '-brief'], { input: '', stdio: 'pipe', timeout: 10_000 }); return true; } catch { return false; } };
    expect(probe('-tls1_3')).toBe(true);
    expect(probe('-tls1_2')).toBe(true);
    expect(probe('-tls1_1')).toBe(false);
    expect(probe('-tls1')).toBe(false);
  });

  test('every page type carries HSTS, the CSP and the other browser protections; the server hides its version', async () => {
    const asset = readFileSync(join(ROOT, 'apps/web/dist/index.html'), 'utf8').match(/\/assets\/[\w.-]+\.js/)![0];
    for (const path of ['/', '/merge', '/pricing', asset, '/api/config', '/healthz']) {
      const r = await http.get(path);
      const h = r.headers();
      expect(h['strict-transport-security'], path).toContain('max-age=63072000');
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['server'], path).toBe('nginx'); // no version number
      expect(h['x-powered-by'], path).toBeUndefined();
      if (!path.startsWith('/api') && path !== '/healthz') {
        expect(h['content-security-policy'], path).toContain("script-src 'self'");
        expect(h['x-frame-options'], path).toBe('DENY');
      }
    }
  });

  test('caching: hashed assets are immutable, pages always revalidate; gzip for static text but never for the API', async () => {
    const asset = readFileSync(join(ROOT, 'apps/web/dist/index.html'), 'utf8').match(/\/assets\/[\w.-]+\.js/)![0];
    const a = await http.get(asset, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(a.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(a.headers()['content-encoding']).toBe('gzip');
    const p = await http.get('/merge', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(p.headers()['cache-control']).toBe('no-cache');
    const j = await http.get('/api/config', { headers: { 'Accept-Encoding': 'gzip' } });
    expect(j.headers()['content-encoding']).toBeUndefined();
  });

  test('SPA fallback works; dotfiles and traversal are refused; internal endpoints are not exposed', async () => {
    const deep = await http.get('/some/unknown/page');
    expect(deep.status()).toBe(200);
    expect(await deep.text()).toContain('<div id="root">');
    expect((await http.get('/.env')).status()).toBe(403);
    expect((await http.get('/assets/.hidden')).status()).toBe(403);
    expect([400, 403, 404]).toContain((await http.get('/assets/..%2f..%2fapi%2fdist%2fserver.js')).status());
    // /metrics and /ready exist on the API's internal port, but nothing at the edge forwards them
    const m = await http.get('/metrics'); expect(await m.text()).not.toContain('pdftools_');
    const r = await http.get('/ready'); expect(await r.text()).not.toContain('"checks"');
    expect((await http.get('/api/metrics')).status()).toBe(404);
    expect((await http.get('/api/docs/')).status()).toBe(404); // Swagger UI is off in production
    const hz = await http.get('/healthz');
    expect(hz.status()).toBe(200);
    expect(await hz.json()).toMatchObject({ status: 'ok' });
  });

  test('the API behind it is in production mode: Secure cookies, token-gated metrics', async () => {
    const fresh = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: edge.httpsUrl }); // no cookies yet, so a guest cookie is issued
    const r = await fresh.get('/api/config');
    await fresh.dispose();
    const cookie = r.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie')!.value;
    expect(cookie).toMatch(/Secure/i); expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Lax/i);
    expect((await fetch(`http://127.0.0.1:${API_PORT}/metrics`)).status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${API_PORT}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('pdftools_build_info');
  });

  test('oversized bodies are rejected at the edge before reaching the API', async () => {
    const r = await http.post('/api/auth/login', { data: 'x'.repeat(2 * 1024 * 1024), headers: { 'Content-Type': 'application/json' } });
    expect(r.status()).toBe(413);
    expect(r.headers()['server']).toBe('nginx');
  });
});

test.describe('real traffic through the edge', () => {
  test('a guest merge works end to end over HTTPS: upload through nginx, separate worker, signed download', async ({ page }) => {
    const mon = watchConsole(page);
    await page.goto(edge.httpsUrl + '/merge');
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.setInputFiles('input[type=file]', [file('a.pdf', await makePdf(2, { label: 'A' })), file('b.pdf', await makePdf(3, { label: 'B' }))]);
    await page.getByRole('button', { name: 'Merge PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 30_000 });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    expect((await PDFDocument.load(readFileSync(await dl.path()))).getPageCount()).toBe(5);
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => c.name === 'pt_guest').every((c) => c.secure && c.httpOnly)).toBe(true);
    expect(mon.problems).toEqual([]);
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('the client IP the API sees is the real one: a spoofed X-Forwarded-For cannot choose the quota identity', async () => {
    const guest = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: edge.httpsUrl }); // own cookie jar = own guest identity
    const r = await guest.post('/api/pdf/rotate', { multipart: { files: { name: 'a.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) }, options: '{"angle":90}' }, headers: { 'X-Forwarded-For': '203.0.113.99' } });
    expect(r.status()).toBe(202);
    const jobId = (await r.json()).data.jobId as string;
    await until(async () => (await (await guest.get(`/api/jobs/${jobId}`)).json()).data.state === 'completed');
    await guest.dispose();
    await mongoose.connect(readState().env.MONGODB_URI!);
    try {
      const keys = (await mongoose.connection.collection('usages').find({ key: /^ip:/ }).toArray()).map((u) => u.key as string);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((k) => k.includes('203.0.113.99'))).toBe(false); // the spoofed address was ignored
      expect(keys.some((k) => /127\.0\.0\.1|::1/.test(k))).toBe(true);
    } finally { await mongoose.disconnect(); }
  });

  test('request ids correlate nginx and the API, and access logs never contain download tokens', async () => {
    const guest = await pwRequest.newContext({ ignoreHTTPSErrors: true, baseURL: edge.httpsUrl });
    const jobPost = await guest.post('/api/pdf/rotate', { multipart: { files: { name: 'c.pdf', mimeType: 'application/pdf', buffer: await makePdf(1) }, options: '{"angle":90}' } });
    const jobId = (await jobPost.json()).data.jobId as string;
    let view: { result?: { downloadUrl: string } } = {};
    await until(async () => { view = (await (await guest.get(`/api/jobs/${jobId}`)).json()).data; return !!view.result; });
    const dl = await guest.get(view.result!.downloadUrl);
    expect(dl.status()).toBe(200);
    const rid = dl.headers()['x-request-id']!;
    expect(rid).toMatch(/^[0-9a-f]{32}$/); // generated by nginx ($request_id), adopted by the API, echoed back
    // nginx writes the access-log line in the last phase of the request, a moment AFTER the client has the whole response: wait for it.
    await until(async () => readFileSync(edge.accessLog, 'utf8').includes(`"request_id":"${rid}"`), 10_000);
    const log = readFileSync(edge.accessLog, 'utf8');
    expect(log).toContain(`"request_id":"${rid}"`);
    expect(log).not.toMatch(/token=/);          // signed download tokens live in the query string and must not be logged
    expect(log).not.toContain(view.result!.downloadUrl.split('token=')[1]!);
    const line = log.split('\n').find((l) => l.includes(rid))!;
    expect(JSON.parse(line)).toMatchObject({ status: 200, method: 'GET', upstream_status: '200' });
    await until(async () => apiLogs.includes(rid), 5000); // the API logged the same id (its logger flushes asynchronously)
    await guest.dispose();
  });

  test('edge rate limiting protects the login endpoint (and answers 429)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await http.post('/api/auth/login', { data: { email: 'nobody@example.com', password: 'x' } })).status());
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(10);
    expect(codes.slice(0, 5).every((c) => c === 401 || c === 400)).toBe(true); // normal requests were served first
  });
});
