import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { pino } from 'pino';
import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb } from './db/models.js';
import { JobRunner } from './modules/jobs/runner.js';
import { MongoJobStore } from './modules/jobs/mongo-store.js';
import { QUEUE_NAME } from './modules/jobs/queue.js';
import { MongoUsageStore } from './modules/usage/store.js';
import { runChecks, storageCheck } from './ops/health.js';
import { Metrics } from './ops/metrics.js';
import { join, resolve } from 'node:path';

/**
 * Standalone job worker: consumes the Redis queue and runs jobs through the same JobRunner the API
 * uses in inline mode. State is shared through MongoDB; the storage directory must be shared with
 * the API (same volume) so results can be downloaded.
 */
export async function startWorker(env = loadEnv(), log = pino({ level: env.LOG_LEVEL }), opts: { ownDb?: boolean } = {}) {
  const ownDb = opts.ownDb ?? true;
  if (!env.REDIS_URL || !env.MONGODB_URI) throw new Error('worker requires REDIS_URL and MONGODB_URI');
  if (ownDb) await connectDb(env.MONGODB_URI);
  let runner!: JobRunner;
  let draining = false;
  const metrics = new Metrics('worker', env.APP_VERSION, async () => {
    metrics.running.set(runner.activeCount);
    metrics.draining.set(draining ? 1 : 0);
  });
  runner = new JobRunner(env, new MongoJobStore(), new MongoUsageStore(), log, metrics);
  const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(QUEUE_NAME, async (job) => { await runner.process(String(job.data.id)); }, { connection: conn, concurrency: env.WORKER_CONCURRENCY });
  worker.on('error', (e) => log.error({ err: e }, 'worker error'));

  // Optional operational endpoint (bind it to an internal interface/network only).
  let http: Server | null = null;
  if (env.WORKER_HEALTH_PORT > 0) {
    const storage = storageCheck(join(resolve(env.STORAGE_DIR), 'jobs'));
    http = createServer((req, res) => {
      void (async () => {
        const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.url === '/health') return json(200, { status: 'ok', role: 'worker', version: env.APP_VERSION });
        if (req.url === '/ready') {
          if (draining || !worker.isRunning()) return json(503, { status: draining ? 'draining' : 'stopped' });
          const r = await runChecks([storage, { name: 'redis', run: async () => { await conn.ping(); } }, { name: 'mongo', run: async () => { await mongoose.connection.db!.admin().ping(); } }]);
          return json(r.ok ? 200 : 503, { status: r.ok ? 'ready' : 'unavailable', checks: r.checks });
        }
        if (req.url === '/metrics') {
          if (env.METRICS_TOKEN && req.headers.authorization !== `Bearer ${env.METRICS_TOKEN}`) return json(401, { status: 'unauthorized' });
          if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) return json(404, { status: 'not_found' });
          res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
          return void res.end(await metrics.registry.metrics());
        }
        json(404, { status: 'not_found' });
      })().catch(() => { res.writeHead(500); res.end(); });
    }).listen(env.WORKER_HEALTH_PORT);
  }
  log.info({ concurrency: env.WORKER_CONCURRENCY, healthPort: env.WORKER_HEALTH_PORT || undefined }, 'worker started');

  return {
    runner, metrics,
    /** Stop taking new jobs, let running ones finish (up to the grace period), then disconnect. */
    close: async (graceMs = env.SHUTDOWN_GRACE_SECONDS * 1000) => {
      draining = true;
      const closing = worker.close(); // waits for active jobs
      await Promise.race([closing, new Promise((r) => setTimeout(r, graceMs))]);
      if (runner.activeCount > 0) { log.warn({ active: runner.activeCount }, 'grace period over; abandoning running jobs (the reaper will fail them)'); await worker.close(true).catch(() => undefined); }
      http?.close();
      await conn.quit().catch(() => undefined);
      if (ownDb) await disconnectDb();
    },
  };
}

// Compare as URLs: a plain string compare breaks when the install path contains spaces or other escaped characters.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const w = await startWorker().catch((e: Error) => { console.error(`FATAL: could not start worker: ${e.message}`); process.exit(1); });
  let stopping = false;
  const stop = (sig: string) => { if (stopping) return; stopping = true; console.log(`${sig} received: finishing running jobs`); void w.close().then(() => { console.log('worker stopped'); process.exit(0); }); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
