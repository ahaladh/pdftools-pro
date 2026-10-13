import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, createWriteStream } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { RedisMemoryServer } from 'redis-memory-server';

export const ROOT = resolve(__dirname, '../..');
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 4101);
const STATE = resolve(__dirname, '../.stack.json');
const LOGS = resolve(__dirname, '../.logs');

export interface StackState {
  webUrl: string; apiUrl: string; adminEmail: string; adminPassword: string; apiLog: string; workerLog: string;
  env: Record<string, string>; pids: { api: number; worker: number; web: number }; storage: string;
}
export const readState = (): StackState => JSON.parse(readFileSync(STATE, 'utf8'));

const procs: { mongo?: MongoMemoryServer; redis?: RedisMemoryServer; api?: ChildProcess; worker?: ChildProcess; web?: ChildProcess } = {};

function launch(name: string, cmd: string, args: string[], env: Record<string, string>, cwd: string): ChildProcess {
  mkdirSync(LOGS, { recursive: true });
  const out = createWriteStream(join(LOGS, `${name}.log`));
  const p = spawn(cmd, args, { cwd, env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  p.stdout?.pipe(out); p.stderr?.pipe(out);
  return p;
}

async function waitFor(url: string, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${what} did not become ready at ${url}. See e2e/.logs/`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Start/stop just the worker (used by the resilience test to simulate a crash). */
export function startWorker(): number {
  const s = readState();
  const p = launch('worker', process.execPath, [join(ROOT, 'apps/api/dist/worker.js')], s.env, join(ROOT, 'apps/api'));
  p.unref();
  writeFileSync(STATE, JSON.stringify({ ...s, pids: { ...s.pids, worker: p.pid! } }, null, 2));
  return p.pid!;
}
export function killWorker() {
  const s = readState();
  try { process.kill(-s.pids.worker, 'SIGKILL'); } catch { /* already gone */ }
}

export async function startStack(): Promise<StackState> {
  for (const f of ['apps/api/dist/server.js', 'apps/web/dist/index.html']) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing. Run "npm run build" first (npm run test:e2e does this for you).`);
  }
  procs.mongo = await MongoMemoryServer.create();
  procs.redis = new RedisMemoryServer(process.env.REDIS_SERVER_BIN ? { binary: { systemBinary: process.env.REDIS_SERVER_BIN } } : {});
  const redisUrl = process.env.REDIS_URL ?? `redis://${await procs.redis.getHost()}:${await procs.redis.getPort()}`;
  const storage = mkdtempSync(join(tmpdir(), 'e2e-storage-'));
  const adminPassword = randomBytes(12).toString('hex');
  const adminEmail = 'admin-e2e@example.com';
  const webUrl = `http://localhost:${WEB_PORT}`, apiUrl = `http://localhost:${API_PORT}`;
  const env: Record<string, string> = {
    NODE_ENV: 'development', PORT: String(API_PORT), STORAGE_DIR: storage, MONGODB_URI: procs.mongo.getUri('pdftools'), QUEUE_DRIVER: 'bullmq', REDIS_URL: redisUrl,
    CORS_ORIGINS: webUrl, PUBLIC_URL: webUrl, JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), DOWNLOAD_SECRET: randomBytes(32).toString('hex'),
    ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword, DAILY_OPS_FREE: '3', DAILY_OPS_GUEST: '60', RATE_LIMIT_ENABLED: 'false',
    HEARTBEAT_STALE_SECONDS: '6', CLEANUP_INTERVAL_SECONDS: '2', WORKER_CONCURRENCY: '2', LOG_LEVEL: 'info', MAX_FILE_MB: '20',
  };
  procs.api = launch('api', process.execPath, [join(ROOT, 'apps/api/dist/server.js')], env, join(ROOT, 'apps/api'));
  await waitFor(`${apiUrl}/health`, 'API');
  procs.worker = launch('worker', process.execPath, [join(ROOT, 'apps/api/dist/worker.js')], env, join(ROOT, 'apps/api'));
  procs.web = launch('web', process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB_PORT), '--strictPort', '--host', 'localhost'], { API_URL: apiUrl }, join(ROOT, 'apps/web'));
  await waitFor(`${webUrl}/`, 'web');
  const state: StackState = {
    webUrl, apiUrl, adminEmail, adminPassword, apiLog: join(LOGS, 'api.log'), workerLog: join(LOGS, 'worker.log'), env, storage,
    pids: { api: procs.api.pid!, worker: procs.worker.pid!, web: procs.web.pid! },
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  return state;
}

export async function stopStack() {
  const s = existsSync(STATE) ? readState() : null;
  for (const pid of s ? [s.pids.web, s.pids.worker, s.pids.api] : []) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of s ? [s.pids.web, s.pids.worker, s.pids.api] : []) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  await procs.mongo?.stop(); await procs.redis?.stop();
  if (s) rmSync(s.storage, { recursive: true, force: true });
  rmSync(STATE, { force: true });
}
