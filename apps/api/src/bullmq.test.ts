import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PDFDocument } from '@cantoo/pdf-lib';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { disconnectDb } from './db/models.js';
import { MongoJobStore } from './modules/jobs/mongo-store.js';
import { startRedis } from './test-utils.js';

// Locally, without a Redis available these tests skip LOUDLY; in CI a missing Redis is a hard failure so coverage cannot silently vanish.
const redis = await startRedis().catch((e) => {
  if (process.env.CI) throw e;
  console.warn(`\n⚠ BullMQ tests SKIPPED: no Redis available (${(e as Error).message.split('\n')[0]}). Set REDIS_URL or REDIS_SERVER_BIN to run them.\n`);
  return null;
});
let mongo: MongoMemoryServer, storage: string;
let ctx: Awaited<ReturnType<typeof createApp>>;
let worker: Awaited<ReturnType<typeof startWorker>> | null = null;
let env: ReturnType<typeof loadEnv>;
const log = pino({ level: 'silent' });
const pdf = async (pages = 1) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([200, 200]); return Buffer.from(await d.save()); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = () => ctx.jobs.store as MongoJobStore;
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 20_000, step = 25): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(step); }
}
const state = async (id: string) => (await store().get(id))?.state;
async function submit(file: Buffer, tool = 'rotate', opts: object = {}, headers: Record<string, string> = {}) {
  const r = await request(ctx.app).post(`/api/pdf/${tool}`).set(headers).field('options', JSON.stringify(opts)).attach('files', file, 'a.pdf');
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  return r.body.data.jobId as string;
}
const startWorkerNow = async (concurrency = 2) => { env.WORKER_CONCURRENCY = concurrency; worker = await startWorker(env, log, { ownDb: false }); };
const stopWorker = async () => { await worker?.close(); worker = null; };

beforeAll(async () => {
  if (!redis) return;
  mongo = await MongoMemoryServer.create();
  storage = await mkdtemp(join(tmpdir(), 'bull-'));
  env = loadEnv({
    NODE_ENV: 'test', STORAGE_DIR: storage, MONGODB_URI: mongo.getUri('pdftools'), QUEUE_DRIVER: 'bullmq', REDIS_URL: redis!.url,
    RATE_LIMIT_ENABLED: 'false', PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '1000', MAX_CONCURRENT_JOBS_PER_USER: '50', MAX_PAGES: '200', JOB_TIMEOUT_SECONDS: '60', WORKER_CONCURRENCY: '2',
  });
  ctx = await createApp({ env });
}, 180_000);
afterAll(async () => { if (!redis) return; await stopWorker(); await ctx.close(); await disconnectDb(); await mongo.stop(); await redis?.stop(); await rm(storage, { recursive: true, force: true }); });

describe.skipIf(!redis)('BullMQ queue with a separate worker', () => {
  it('config requires Redis and Mongo for the bullmq driver', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', QUEUE_DRIVER: 'bullmq' })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ NODE_ENV: 'test', QUEUE_DRIVER: 'bullmq', REDIS_URL: 'redis://x' })).toThrow(/MONGODB_URI/);
  });

  it('the API does not process jobs itself: without a worker the job just waits', async () => {
    expect(ctx.jobs.runner).toBeNull();
    const id = await submit(await pdf());
    await sleep(600);
    expect(await state(id)).toBe('queued');
    expect((await ctx.jobs.queueStats()).waiting).toBeGreaterThanOrEqual(1);
    // clean up so later tests start from an empty queue
    await ctx.jobs.cancel((await store().get(id))!);
  });

  it('a worker started later picks the work up; results download through the API', async () => {
    const id = await submit(await pdf(2), 'rotate', { angle: 90 });
    await startWorkerNow(2);
    await until(async () => (await state(id)) === 'completed');
    const agentJob = await store().get(id);
    expect(agentJob!.heartbeatAt).toBeTypeOf('number'); // processed by a runner, not the API
    expect(agentJob!.result!.bytes).toBeGreaterThan(0);
  });

  it('end to end over HTTP including signed download', async () => {
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/merge').attach('files', await pdf(2), 'a.pdf').attach('files', await pdf(3), 'b.pdf');
    expect(sub.status).toBe(202);
    const job = await until(async () => { const r = await agent.get(`/api/jobs/${sub.body.data.jobId}`); return r.body.data.state === 'completed' ? r.body.data : false; });
    const dl = await agent.get(job.result.downloadUrl).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((await PDFDocument.load(dl.body)).getPageCount()).toBe(5);
  });

  it('runs higher-priority plans first', async () => {
    await stopWorker();
    const reg = await request(ctx.app).post('/api/auth/register').send({ email: 'biz@example.com', password: 'correct horse battery', name: 'b' });
    await (await import('./db/models.js')).UserModel.updateOne({ email: 'biz@example.com' }, { plan: 'business' });
    const t = reg.body.data.accessToken;
    const lows: string[] = [];
    for (let i = 0; i < 3; i++) lows.push(await submit(await pdf(), 'rotate'));
    const high = await submit(await pdf(), 'rotate', {}, { Authorization: `Bearer ${t}` });
    const started: string[] = [];
    await startWorkerNow(1); // one at a time makes the order observable
    await until(async () => {
      for (const id of [high, ...lows]) { const s = await state(id); if (s !== 'queued' && !started.includes(id)) started.push(id); }
      return started.length >= 2;
    }, 20_000, 2);
    expect(started[0]).toBe(high); // submitted last, started first
    await until(async () => (await state(lows[2]!)) === 'completed');
    await stopWorker();
  });

  it('cancelling a queued job removes it from Redis; a worker never runs it', async () => {
    await stopWorker();
    const id = await submit(await pdf());
    const r = await request(ctx.app).post(`/api/jobs/${id}/cancel`);
    // different identity => 404; cancel as the owner instead
    expect(r.status).toBe(404);
    const owner = request.agent(ctx.app);
    const sub = await owner.post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    const c = await owner.post(`/api/jobs/${sub.body.data.jobId}/cancel`);
    expect(c.body.data.state).toBe('cancelled');
    await startWorkerNow(2);
    await until(async () => (await state(id)) === 'completed'); // the other (uncancelled) job still runs
    await sleep(300);
    expect(await state(sub.body.data.jobId)).toBe('cancelled'); // and the cancelled one never did
    await stopWorker();
  });

  it('cancels a RUNNING job across processes through the shared store', async () => {
    await startWorkerNow(1);
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ format: 'png', dpi: 300 })).attach('files', await pdf(150), 'big.pdf');
    const id = sub.body.data.jobId as string;
    await until(async () => (await state(id)) === 'processing');
    const t0 = Date.now();
    expect((await agent.post(`/api/jobs/${id}/cancel`)).status).toBe(200);
    await until(async () => (await state(id)) === 'cancelled', 15_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
    await stopWorker();
  }, 60_000);

  it('a job claimed twice (duplicate delivery) runs exactly once', async () => {
    await stopWorker();
    const id = await submit(await pdf());
    const { JobRunner } = await import('./modules/jobs/runner.js');
    const r1 = new JobRunner(env, store(), ctx.usage, log), r2 = new JobRunner(env, store(), ctx.usage, log);
    await Promise.all([r1.process(id), r2.process(id)]);
    expect(await state(id)).toBe('completed');
    // Each anonymous request gets its own guest cookie, so this key counts only THIS job's completions.
    const guestKey = (await store().get(id))!.usageKeys.find((k) => k.startsWith('g:'))!;
    expect(await ctx.usage.ops(guestKey)).toBe(1);
    // A second execution would have written a second result file before losing the final atomic transition.
    expect(await (await import('node:fs/promises')).readdir(join((await store().get(id))!.dir, 'out'))).toHaveLength(1);
    await ctx.jobs.queue.remove(id);
  });

  it('reaper: a job whose worker died (stale heartbeat) is failed, a live one is not', async () => {
    const dead = await submit(await pdf()); const alive = await submit(await pdf());
    await ctx.jobs.queue.remove(dead); await ctx.jobs.queue.remove(alive);
    await store().update(dead, { state: 'processing', heartbeatAt: Date.now() - 120_000 });
    await store().update(alive, { state: 'processing', heartbeatAt: Date.now() });
    await ctx.jobs.sweep();
    expect(await state(dead)).toBe('failed');
    expect((await store().get(dead))!.error!.code).toBe('worker_lost');
    expect(await state(alive)).toBe('processing');
  });

  it('reaper: a job that sat in the queue past the timeout is failed', async () => {
    await stopWorker();
    const id = await submit(await pdf());
    await ctx.jobs.sweep(Date.now() + (env.QUEUE_TIMEOUT_SECONDS + 5) * 1000);
    expect(await state(id)).toBe('failed');
    expect((await store().get(id))!.error!.code).toBe('queue_timeout');
  });

  it('the worker serves health/ready/metrics and, on graceful close, finishes the job it is running', async () => {
    await stopWorker();
    const port = await new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
    const agent = request.agent(ctx.app);
    const sub = await agent.post('/api/pdf/pdf-to-images').field('options', JSON.stringify({ format: 'png', dpi: 200 })).attach('files', await pdf(150), 'long.pdf');
    const id = sub.body.data.jobId as string;
    const w = await startWorker({ ...env, WORKER_CONCURRENCY: 1, WORKER_HEALTH_PORT: port } as typeof env, log, { ownDb: false });
    worker = w;
    await until(async () => (await state(id)) === 'processing');
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { storage: 'ok', redis: 'ok', mongo: 'ok' } });
    expect(await (await fetch(`${base}/metrics`)).text()).toMatch(/pdftools_jobs_running 1/);
    expect((await fetch(`${base}/nope`)).status).toBe(404);

    const closing = w.close(); // SIGTERM equivalent: stop taking work, finish what is running
    await sleep(200);
    expect(await state(id)).toBe('processing'); // not abandoned
    await closing;
    worker = null;
    expect(await state(id)).toBe('completed'); // it finished before the worker went away
    expect(await (async () => { try { await fetch(`${base}/health`); return 'open'; } catch { return 'closed'; } })()).toBe('closed');
    expect(await w.metrics.registry.metrics()).toMatch(/pdftools_jobs_total\{tool="pdf-to-images",outcome="completed"\} 1/);
  }, 90_000);

  it('answers 503 quickly (instead of hanging) when Redis is unreachable', async () => {
    const env2 = loadEnv({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_'))) as Record<string, string>, NODE_ENV: 'test', STORAGE_DIR: join(storage, 'x'), MONGODB_URI: mongo.getUri('pdftools'), QUEUE_DRIVER: 'bullmq', REDIS_URL: 'redis://127.0.0.1:1', RATE_LIMIT_ENABLED: 'false', PREMIUM_TOOLS: '', DAILY_OPS_GUEST: '1000' });
    const app2 = await createApp({ env: env2 });
    const t0 = Date.now();
    const r = await request(app2.app).post('/api/pdf/rotate').attach('files', await pdf(), 'a.pdf');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('queue_unavailable');
    const ready = await request(app2.app).get('/ready'); // readiness reflects the outage, liveness does not
    expect(ready.status).toBe(503);
    expect(ready.body.checks).toMatchObject({ redis: expect.stringMatching(/failed|timeout/), mongo: 'ok', storage: 'ok' });
    expect((await request(app2.app).get('/health')).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(8000);
    await app2.close();
  }, 30_000);
});
