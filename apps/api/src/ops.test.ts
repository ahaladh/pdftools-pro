import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { runChecks } from './ops/health.js';

let storage: string;
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const mk = async (over: Record<string, string> = {}) => {
  const a = await createApp({ env: loadEnv({ NODE_ENV: 'test', STORAGE_DIR: await mkdtemp(join(storage, 'a-')), PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '100000', RATE_LIMIT_ENABLED: 'false', ...over }) });
  apps.push(a); return a;
};
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([200, 200]); return Buffer.from(await d.save()); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
async function waitDone(agent: ReturnType<typeof request.agent>, id: string) {
  for (let i = 0; i < 300; i++) { const r = await agent.get(`/api/jobs/${id}`); if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data; await sleep(40); }
  throw new Error('timeout');
}

beforeAll(async () => { storage = await mkdtemp(join(tmpdir(), 'ops-')); });
afterAll(async () => { for (const a of apps) await a.close(); await chmod(storage, 0o700).catch(() => undefined); await rm(storage, { recursive: true, force: true }); });

describe('health and readiness', () => {
  it('liveness is dependency-free and reports the version', async () => {
    const { app } = await mk({ APP_VERSION: '1.2.3' });
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', version: '1.2.3', uptimeSeconds: expect.any(Number) });
  });

  it('readiness verifies the storage directory is writable', async () => {
    const { app } = await mk();
    const ok = await request(app).get('/ready');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'ready', checks: { storage: 'ok' } });
  });

  it.skipIf(process.getuid?.() === 0)('readiness fails (503) when storage is not writable, while liveness stays up', async () => {
    const a = await mk();
    await chmod(a.jobs.root, 0o500);
    try {
      const r = await request(a.app).get('/ready');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ status: 'unavailable', checks: { storage: 'failed' } }); // no paths or error text leaked
      expect((await request(a.app).get('/health')).status).toBe(200);
    } finally { await chmod(a.jobs.root, 0o700); }
    expect((await request(a.app).get('/ready')).status).toBe(200); // recovers by itself
  });

  it('readiness reports "draining" during shutdown so load balancers stop routing', async () => {
    const a = await mk();
    a.setDraining(true);
    const r = await request(a.app).get('/ready');
    expect(r.status).toBe(503);
    expect(r.body.status).toBe('draining');
    expect((await request(a.app).get('/health')).status).toBe(200);
    a.setDraining(false);
    expect((await request(a.app).get('/ready')).status).toBe(200);
  });

  it('runChecks times out a hung dependency and never leaks error text', async () => {
    const r = await runChecks([
      { name: 'fast', run: async () => undefined },
      { name: 'hung', run: () => new Promise(() => undefined) },
      { name: 'broken', run: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:27017 password=secret'); } },
    ], 150);
    expect(r).toEqual({ ok: false, checks: { fast: 'ok', hung: 'timeout', broken: 'failed' } });
  });
});

describe('request ids', () => {
  it('adopts a sane X-Request-Id from the proxy, replaces a hostile one, and echoes it back', async () => {
    const { app } = await mk();
    const ok = await request(app).get('/health').set('X-Request-Id', 'abc12345-def6');
    expect(ok.headers['x-request-id']).toBe('abc12345-def6');
    for (const bad of ['x', 'has space in it!!', 'a'.repeat(200), '<script>alert(1)</script>']) {
      const r = await request(app).get('/health').set('X-Request-Id', bad);
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/); // a fresh UUID, never the hostile value
    }
    const a = await request(app).get('/health'), b = await request(app).get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('prometheus metrics', () => {
  it('records jobs, latency by route PATTERN, errors, and queue gauges', async () => {
    const { app } = await mk();
    const agent = request.agent(app);
    const sub = await agent.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    await waitDone(agent, sub.body.data.jobId);
    const bad = await agent.post('/api/pdf/rotate').attach('files', Buffer.from('%PDF-1.4\njunk'), 'b.pdf');
    await waitDone(agent, bad.body.data.jobId);
    await request(app).get('/api/nope');
    await agent.get(`/api/jobs/${'f'.repeat(32)}`);
    const m = (await request(app).get('/metrics')).text;
    expect(m).toMatch(/pdftools_jobs_total\{tool="rotate",outcome="completed"\} 1/);
    expect(m).toMatch(/pdftools_jobs_total\{tool="rotate",outcome="failed"\} 1/);
    expect(m).toMatch(/pdftools_job_failures_total\{code="invalid_pdf"\} 1/);
    expect(m).toMatch(/pdftools_job_duration_seconds_count\{tool="rotate"\} 2/);
    expect(m).toMatch(/pdftools_api_errors_total\{code="not_found",status="404"\} 2/);
    // cardinality guard: route labels are patterns, never raw ids or paths
    expect(m).toContain('route="/api/jobs/:jobId"');
    expect(m).toContain('route="/api/pdf/:tool"');
    expect(m).not.toContain(`/api/jobs/${'f'.repeat(32)}`);
    expect(m).toMatch(/pdftools_queue_jobs\{state="waiting"\} 0/);
    expect(m).toMatch(/pdftools_storage_bytes \d+/);
    expect(m).toMatch(/pdftools_build_info\{version="dev",role="api"\} 1/);
    expect(m).toMatch(/pdftools_process_cpu_user_seconds_total/);
    expect(m).not.toMatch(/g:[a-f0-9]{32}/); // no owner identifiers in metrics
  });

  it('is open in development, disabled in production without a token, and token-protected with one', async () => {
    const prodBase = { NODE_ENV: 'production', DOWNLOAD_SECRET: 'x'.repeat(40) };
    const noToken = await mk(prodBase);
    expect((await request(noToken.app).get('/metrics')).status).toBe(404);
    const withToken = await mk({ ...prodBase, METRICS_TOKEN: 'scrape-token-1234567' });
    expect((await request(withToken.app).get('/metrics')).status).toBe(401);
    expect((await request(withToken.app).get('/metrics').set('Authorization', 'Bearer wrong-token-1234567')).status).toBe(401); // same length
    expect((await request(withToken.app).get('/metrics').set('Authorization', 'Bearer short')).status).toBe(401);
    const ok = await request(withToken.app).get('/metrics').set('Authorization', 'Bearer scrape-token-1234567');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await request(withToken.app).get('/api/metrics')).status).toBe(404); // not reachable through the /api prefix a proxy forwards
  });
});

describe('graceful shutdown (real server process)', () => {
  let child: ChildProcess | null = null;
  afterAll(() => { child?.kill('SIGKILL'); });

  it('on SIGTERM: reports draining, stops accepting, lets the running job finish, then exits 0', async () => {
    const port = await freePort();
    const store = await mkdtemp(join(storage, 'srv-'));
    const logs: string[] = [];
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: join(__dirname, '..'),
      env: { PATH: process.env.PATH!, NODE_ENV: 'test', PORT: String(port), STORAGE_DIR: store, PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '1000', RATE_LIMIT_ENABLED: 'false', SHUTDOWN_DRAIN_SECONDS: '1', SHUTDOWN_GRACE_SECONDS: '60', LOG_LEVEL: 'silent', MAX_PAGES: '400' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d: Buffer) => logs.push(d.toString()));
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(100); }

    // start a job that takes a while
    const form = new FormData();
    form.append('options', JSON.stringify({ format: 'png', dpi: 200 }));
    form.append('files', new Blob([await pdf(250)], { type: 'application/pdf' }), 'long.pdf');
    const sub = await fetch(`${base}/api/pdf/pdf-to-images`, { method: 'POST', body: form });
    expect(sub.status).toBe(202);
    const cookie = sub.headers.get('set-cookie')!.split(';')[0]!;
    const jobId = ((await sub.json()) as { data: { jobId: string } }).data.jobId;
    for (let i = 0; i < 100; i++) { const j = (await (await fetch(`${base}/api/jobs/${jobId}`, { headers: { cookie } })).json()) as { data: { state: string } }; if (j.data.state === 'processing') break; await sleep(30); }

    const exited = new Promise<number | null>((res) => child!.on('exit', (c) => res(c)));
    const t0 = Date.now();
    child.kill('SIGTERM');
    await sleep(300);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { status: string }).status).toBe('draining');
    expect((await fetch(`${base}/health`)).status).toBe(200); // still alive while draining

    expect(await exited).toBe(0); // clean exit, not a kill
    expect(Date.now() - t0).toBeGreaterThan(3000); // outlived the 1 s drain: it really waited for the job (a 250-page render takes several seconds)
    expect(logs.join('')).toContain('shutdown complete');
    // the in-flight job was allowed to finish: its result file exists on disk
    const dirs = await readdir(join(store, 'jobs'));
    expect(dirs).toHaveLength(1);
    expect(await readdir(join(store, 'jobs', dirs[0]!))).toEqual(['out']);
    await expect(fetch(`${base}/health`)).rejects.toThrow(); // and the port is closed
  }, 120_000);
});
