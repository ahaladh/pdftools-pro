import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { PDFDocument } from '@cantoo/pdf-lib';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { listRoutes } from './route-list.js';

let storage: string;
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const mk = async (over: Record<string, string> = {}) => {
  const a = await createApp({ env: loadEnv({ NODE_ENV: 'test', STORAGE_DIR: await mkdtemp(join(storage, 'a-')), MAX_FILE_MB: '1', MAX_FILES: '3', MAX_PAGES: '10', PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '100000', RATE_LIMIT_ENABLED: 'false', CORS_ORIGINS: 'http://localhost:5173', ...over }) });
  apps.push(a); return a;
};
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([200, 200]); return Buffer.from(await d.save()); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitDone(agent: ReturnType<typeof request.agent>, id: string) {
  for (let i = 0; i < 300; i++) { const r = await agent.get(`/api/jobs/${id}`); if (['completed', 'failed', 'cancelled'].includes(r.body.data.state)) return r.body.data; await sleep(40); }
  throw new Error('timeout');
}
function pngBomb(w: number, h: number): Buffer {
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(h * (1 + w * 4)), { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

beforeAll(async () => { storage = await mkdtemp(join(tmpdir(), 'sec-')); });
afterAll(async () => { for (const a of apps) await a.close(); await rm(storage, { recursive: true, force: true }); });

describe('authorization matrix (guest mode)', () => {
  // Every route the app registers must be classified here. Adding an endpoint without deciding who may call it fails this test.
  const PUBLIC = ['GET /api/config', 'GET /api/openapi.json', 'GET /api/plans', 'GET /api/tools', 'GET /health', 'GET /ready'];
  const OWNER_SCOPED = ['DELETE /api/files/:fileId', 'GET /api/files/:fileId/download', 'GET /api/jobs/:jobId', 'POST /api/jobs/:jobId/cancel'];
  const PROCESSING = ['POST /api/pdf/:tool'];
  // Operational: Prometheus scrape endpoint. Open in development, token-required in production (see ops.test.ts), never under /api.
  const OPERATIONAL = ['GET /metrics'];

  it('has no unclassified routes', async () => {
    const { app } = await mk();
    expect(listRoutes(app)).toEqual([...PUBLIC, ...OWNER_SCOPED, ...PROCESSING, ...OPERATIONAL].sort());
  });

  it('public routes work without any identity', async () => {
    const { app } = await mk();
    for (const r of PUBLIC) { const [m, p] = r.split(' ') as [string, string]; expect((await request(app).get(p)).status, r).toBe(200); void m; }
  });

  it('owner-scoped routes never reveal other guests\' resources (404, not 403) or accept malformed ids', async () => {
    const { app } = await mk();
    const alice = request.agent(app), mallory = request.agent(app);
    const sub = await alice.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    const job = await waitDone(alice, sub.body.data.jobId);
    const fid = job.result.fileId as string;
    expect((await mallory.get(`/api/jobs/${job.id}`)).status).toBe(404);
    expect((await mallory.post(`/api/jobs/${job.id}/cancel`)).status).toBe(404);
    expect((await mallory.delete(`/api/files/${fid}`)).status).toBe(404);
    expect((await mallory.get(job.result.downloadUrl)).status).toBe(404);
    for (const bad of ['..%2f..%2fetc%2fpasswd', '%2e%2e', 'x'.repeat(5000), '../', 'a b', '0'.repeat(31), '%00']) {
      expect((await alice.get(`/api/jobs/${bad}`)).status, `job ${bad.slice(0, 20)}`).toBe(404);
      expect([403, 404], `file ${bad.slice(0, 20)}`).toContain((await alice.get(`/api/files/${bad}/download?token=1.x`)).status);
      expect((await alice.delete(`/api/files/${bad}`)).status).toBe(404);
    }
  });

  it('account/billing/admin endpoints answer 503 "accounts_disabled" when no database is configured', async () => {
    const { app } = await mk();
    for (const p of ['/api/auth/login', '/api/me', '/api/billing/checkout', '/api/admin/users', '/api/admin/settings']) {
      const r = await request(app).get(p);
      expect([503, 404]).toContain(r.status);
      if (r.status === 503) expect(r.body.error.code).toBe('accounts_disabled');
    }
    expect((await request(app).get('/api/admin/users').set('Authorization', 'Bearer abc')).status).toBe(401); // a token cannot conjure accounts
  });
});

describe('rate limiting', () => {
  it('limits request volume per client with a JSON 429 and recovers after the window', async () => {
    const { app } = await mk({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX_PER_WINDOW: '5', RATE_LIMIT_WINDOW_SECONDS: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await request(app).get('/api/config')).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    const r = await request(app).get('/api/config');
    expect(r.body).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(r.headers['ratelimit'] ?? r.headers['ratelimit-policy']).toBeDefined();
    await sleep(2200);
    expect((await request(app).get('/api/config')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200); // health checks are not rate limited
  });
});

describe('upload abuse', () => {
  it('rejects an oversized options field, an unexpected file field and non-multipart bodies without a 500', async () => {
    const { app } = await mk();
    const big = await request(app).post('/api/pdf/rotate').field('options', 'x'.repeat(6 * 1024 * 1024)).attach('files', await pdf(), 'a.pdf');
    expect([400, 413]).toContain(big.status);
    const wrongField = await request(app).post('/api/pdf/rotate').attach('document', await pdf(), 'a.pdf');
    expect(wrongField.status).toBe(400);
    const json = await request(app).post('/api/pdf/rotate').send({ files: 'nope' });
    expect(json.status).toBeLessThan(500);
    const garbage = await request(app).post('/api/pdf/rotate').set('Content-Type', 'multipart/form-data; boundary=xyz').send('--xyz\r\nbroken');
    expect(garbage.status).toBeLessThan(500);
    const huge = await request(app).post('/api/pdf/rotate').set('Content-Type', 'application/json').send('{"a":"' + 'x'.repeat(200_000) + '"}');
    expect(huge.status).toBeLessThan(500);
  });

  it('removes every temporary file after rejected uploads', async () => {
    const a = await mk();
    const before = (await readdir(a.jobs.root)).length;
    await request(a.app).post('/api/pdf/rotate').attach('files', Buffer.alloc(1.5 * 1024 * 1024, 1), 'big.pdf'); // too big
    await request(a.app).post('/api/pdf/rotate').attach('files', Buffer.from('not a pdf'), 'x.pdf'); // wrong type
    await request(a.app).post('/api/pdf/rotate').field('options', '{bad json').attach('files', await pdf(), 'a.pdf');
    await request(a.app).post('/api/pdf/rotate').field('options', JSON.stringify({ angle: 7 })).attach('files', await pdf(), 'a.pdf');
    expect((await readdir(a.jobs.root)).length).toBe(before);
  });

  it('neutralises hostile filenames in results and headers', async () => {
    const { app } = await mk();
    const agent = request.agent(app);
    for (const name of ['../../etc/passwd.pdf', 'a\u0000b.pdf', 'evil‮gnp.pdf', '"quoted";x.pdf', 'x'.repeat(400) + '.pdf', '..\\..\\win.pdf']) {
      const sub = await agent.post('/api/pdf/split').field('options', '{"mode":"each"}').attach('files', await pdf(1), { filename: name, contentType: 'application/pdf' });
      if (sub.status !== 202) { expect(sub.status, name).toBeLessThan(500); continue; }
      const job = await waitDone(agent, sub.body.data.jobId);
      expect(job.state, name).toBe('completed');
      expect(job.result.name).toMatch(/^[\w.\- ()]+$/);
      expect(job.result.name.length).toBeLessThanOrEqual(135); // sanitized stem (<=120) plus the tool's own suffix
      const dl = await agent.get(job.result.downloadUrl);
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="[^"\r\n]*"/);
      expect(dl.headers['content-disposition']).not.toMatch(/[\r\n]/);
    }
  });

  it('answers quickly when a ZIP with tens of thousands of entries is posted as an Office file', async () => {
    const { app } = await mk({ MAX_FILE_MB: '5' });
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30_000; i++) entries[`word/${i}.xml`] = new Uint8Array(0);
    const zip = Buffer.from(zipSync(entries, { level: 0 }));
    const t0 = Date.now();
    const r = await request(app).post('/api/pdf/office-to-pdf').attach('files', zip, 'bomb.docx');
    expect(r.status).toBe(415); // no [Content_Types].xml => not an Office document
    expect(Date.now() - t0).toBeLessThan(5000);
    void strToU8;
  });
});

describe('resource exhaustion', () => {
  it('a decompression-bomb image fails the job with a resource error and the API keeps serving', async () => {
    const { app } = await mk({ MAX_FILE_MB: '5', ISOLATION_MEMORY_MB: '1536', ENGINE_MEMORY_MB: '1536' });
    const agent = request.agent(app);
    const bomb = pngBomb(12000, 8000);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    const sub = await agent.post('/api/pdf/images-to-pdf').attach('files', bomb, 'bomb.png');
    expect(sub.status).toBe(202);
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('failed');
    expect(job.error.code).toBe('resource_limit');
    expect((await request(app).get('/health')).status).toBe(200);
    const ok = await agent.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    expect((await waitDone(agent, ok.body.data.jobId)).state).toBe('completed');
  }, 120_000);

  it('a flood of parallel submissions from one client is capped by the concurrency limit', async () => {
    const { app } = await mk({ MAX_CONCURRENT_JOBS_PER_USER: '2', WORKER_CONCURRENCY: '1' });
    const agent = request.agent(app);
    await agent.get('/api/config'); // establish the guest cookie first
    const body = await pdf(5);
    const results = await Promise.all(Array.from({ length: 12 }, () => agent.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ dpi: 150 })).attach('files', body, 'a.pdf').then((r) => r.status)));
    const accepted = results.filter((s) => s === 202).length;
    expect(accepted).toBe(2); // exactly the limit: slots are reserved atomically, parallel requests cannot all slip through
    expect(results.filter((s) => s === 429).length).toBe(12 - accepted);
    expect(results.every((s) => s === 202 || s === 429)).toBe(true); // never a 5xx
  }, 60_000);

  it('enforces the whole-job deadline', async () => {
    const { app } = await mk({ JOB_TIMEOUT_SECONDS: '1', MAX_PAGES: '400', MAX_FILE_MB: '5' });
    const agent = request.agent(app);
    const sub = await agent.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ format: 'png', dpi: 300 })).attach('files', await pdf(300), 'many.pdf');
    const t0 = Date.now();
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.state).toBe('failed');
    expect(job.error.code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);

  it('refuses new work when the storage cap is reached, then recovers after cleanup', async () => {
    const a = await mk({ MAX_STORAGE_MB: '0.005', STORAGE_CACHE_SECONDS: '0' });
    const agent = request.agent(a.app);
    // fill storage with a result larger than the cap: a 6-page render
    const sub = await agent.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ format: 'png', dpi: 300 })).attach('files', await pdf(6), 'a.pdf');
    expect((await waitDone(agent, sub.body.data.jobId)).state).toBe('completed');
    const blocked = await agent.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('storage_full');
    await a.jobs.sweep(Date.now() + 365 * 24 * 3600 * 1000); // retention passes
    expect((await readdir(a.jobs.root)).length).toBe(0);
    expect((await agent.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf')).status).toBe(202);
  }, 60_000);

  it('a page-count bomb is rejected fast by the page limit', async () => {
    const { app } = await mk();
    const agent = request.agent(app);
    const sub = await agent.post('/api/pdf/rotate').attach('files', await pdf(40), 'p.pdf');
    const job = await waitDone(agent, sub.body.data.jobId);
    expect(job.error.code).toBe('too_many_pages');
  });
});

describe('browser-facing hardening', () => {
  it('sends security headers and hides the framework', async () => {
    const { app } = await mk();
    const r = await request(app).get('/api/config');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('CORS allows only configured origins, with credentials, and never wildcards', async () => {
    const { app } = await mk();
    const ok = await request(app).options('/api/pdf/rotate').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).options('/api/pdf/rotate').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const evilGet = await request(app).get('/api/config').set('Origin', 'https://evil.example');
    expect(evilGet.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.stringify(ok.headers)).not.toContain('"*"');
  });

  it('sets the guest cookie httpOnly + SameSite=Lax and not Secure in dev, Secure in production', async () => {
    const dev = await request((await mk()).app).get('/api/config');
    const c = (dev.headers['set-cookie'] as unknown as string[])[0]!;
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=Lax/i); expect(c).not.toMatch(/Secure/i);
    const prod = await createApp({ env: loadEnv({ NODE_ENV: 'production', DOWNLOAD_SECRET: 'x'.repeat(40), STORAGE_DIR: await mkdtemp(join(storage, 'p-')), RATE_LIMIT_ENABLED: 'false' }) });
    apps.push(prod);
    expect(((await request(prod.app).get('/api/config')).headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/i);
    expect((await request(prod.app).get('/api/docs/')).status).toBe(404); // Swagger UI is not exposed in production
  });

  it('error responses never leak stack traces or server paths', async () => {
    const { app } = await mk();
    const responses = [
      await request(app).get('/api/nope'), await request(app).post('/api/pdf/rotate').send('{'),
      await request(app).post('/api/pdf/rotate').set('Content-Type', 'application/json').send('{"x":'), await request(app).get('/api/jobs/zzz'),
      await request(app).post('/api/pdf/rotate').attach('files', Buffer.from('x'), 'a.pdf'),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body) + r.text;
      expect(text).not.toMatch(/node_modules|\/home\/|\/tmp\/|at \w+ \(|\.ts:\d+|SyntaxError|Error:/);
      expect(r.body.ok).toBe(false);
    }
  });

  it('serves downloads as attachments with nosniff and no caching', async () => {
    const { app } = await mk();
    const agent = request.agent(app);
    const sub = await agent.post('/api/pdf/pdf-to-text').attach('files', await pdf(), 'a.pdf');
    const job = await waitDone(agent, sub.body.data.jobId);
    const dl = await agent.get(job.result.downloadUrl);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['cache-control']).toMatch(/no-store/);
    // a user-controlled filename must not turn a text/html result into something the browser renders inline
    expect(['text/plain; charset=utf-8', 'application/pdf']).toContain(dl.headers['content-type']);
  });
});

describe('cleanup and retention', () => {
  it('removes inputs of failed and cancelled jobs immediately and results at retention', async () => {
    const a = await mk({ WORKER_CONCURRENCY: '1' });
    const agent = request.agent(a.app);
    const bad = await agent.post('/api/pdf/rotate').attach('files', Buffer.from('%PDF-1.4\njunk'), 'bad.pdf');
    await waitDone(agent, bad.body.data.jobId);
    expect(await readdir(join(a.jobs.root, bad.body.data.jobId))).toEqual([]);
    const ok = await agent.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    await waitDone(agent, ok.body.data.jobId);
    expect(await readdir(join(a.jobs.root, ok.body.data.jobId))).toEqual(['out']);
    await a.jobs.sweep(Date.now() + 365 * 24 * 3600 * 1000);
    await expect(stat(join(a.jobs.root, ok.body.data.jobId))).rejects.toThrow();
    expect((await agent.get(`/api/jobs/${ok.body.data.jobId}`)).body.data.state).toBe('expired');
  });
});

describe('configuration parsing', () => {
  it('parses booleans correctly ("false" must be false)', () => {
    const base = { NODE_ENV: 'test' };
    expect(loadEnv({ ...base, MAINTENANCE_MODE: 'false' }).MAINTENANCE_MODE).toBe(false);
    expect(loadEnv({ ...base, MAINTENANCE_MODE: '0' }).MAINTENANCE_MODE).toBe(false);
    expect(loadEnv({ ...base, MAINTENANCE_MODE: 'true' }).MAINTENANCE_MODE).toBe(true);
    expect(loadEnv({ ...base, MAINTENANCE_MODE: '1' }).MAINTENANCE_MODE).toBe(true);
    expect(loadEnv({ ...base, MAINTENANCE_MODE: '' }).MAINTENANCE_MODE).toBe(false);
    expect(loadEnv(base).ISOLATE_JOBS).toBe(true);
    expect(loadEnv({ ...base, ISOLATE_JOBS: 'false' }).ISOLATE_JOBS).toBe(false);
    expect(() => loadEnv({ ...base, MAINTENANCE_MODE: 'maybe' })).toThrow();
  });
  it('explains invalid configuration in plain words instead of a validation dump', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', DOWNLOAD_SECRET: 'short' })).toThrow(/Invalid configuration:\n\s+- DOWNLOAD_SECRET: /);
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/- PORT: /);
    try { loadEnv({ MAINTENANCE_MODE: 'maybe', PORT: 'x' }); } catch (e) { expect((e as Error).message.split('\n').filter((l) => l.startsWith('  - ')).length).toBe(2); expect((e as Error).message).not.toMatch(/ZodError|at \w+ \(/); }
  });
  it('requires secrets in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/DOWNLOAD_SECRET/);
    expect(() => loadEnv({ NODE_ENV: 'production', DOWNLOAD_SECRET: 'x'.repeat(40), MONGODB_URI: 'mongodb://x' })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ NODE_ENV: 'production', DOWNLOAD_SECRET: 'short' })).toThrow();
  });
});
