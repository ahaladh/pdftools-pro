import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobRunner } from './runner.js';

export interface JobQueue {
  add(id: string, priority: number): Promise<void>;
  /** Remove a not-yet-started job. Returns true if it was still waiting. */
  remove(id: string): Promise<boolean>;
  stats(): Promise<{ waiting: number; active: number }>;
  /** Verify the backing service is reachable (readiness). */
  ping?(): Promise<void>;
  close(): Promise<void>;
}

/** Runs jobs inside this process with bounded concurrency; highest plan priority first. */
export class InlineQueue implements JobQueue {
  private waiting: { id: string; priority: number; seq: number }[] = [];
  private seq = 0;
  private active = 0;
  constructor(private runner: JobRunner, private concurrency: () => number) {}

  async add(id: string, priority: number) { this.waiting.push({ id, priority, seq: this.seq++ }); this.pump(); }
  async remove(id: string) { const n = this.waiting.length; this.waiting = this.waiting.filter((w) => w.id !== id); return this.waiting.length < n; }
  async stats() { return { waiting: this.waiting.length, active: this.active }; }
  async close() { /* in-flight jobs are abandoned on shutdown; the reaper fails them */ }

  private pump() {
    while (this.active < this.concurrency() && this.waiting.length) {
      this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const { id } = this.waiting.shift()!;
      this.active++;
      void this.runner.process(id).catch(() => undefined).finally(() => { this.active--; this.pump(); });
    }
  }
}

export const QUEUE_NAME = 'pdf-jobs';
const OP_TIMEOUT_MS = 3000;

/** BullMQ waits indefinitely for a connection; an outage must surface as a quick error, not a hung request. */
function within<T>(p: Promise<T>, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`queue ${what} timed out (is Redis reachable?)`)), OP_TIMEOUT_MS); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Producer side of the Redis queue. Workers (see worker.ts) consume it. */
export class BullQueue implements JobQueue {
  private conn: Redis;
  private q: Queue;
  constructor(redisUrl: string) {
    // Producer: fail fast when Redis is unreachable instead of queueing commands forever.
    this.conn = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 200, 2000) });
    this.conn.on('error', () => undefined); // surfaced through add()/stats() rejections
    this.q = new Queue(QUEUE_NAME, { connection: this.conn, defaultJobOptions: { removeOnComplete: true, removeOnFail: true, attempts: 1 } });
  }
  /** BullMQ: lower number = higher priority. Plan priority 0..100 maps to 100..1. */
  async add(id: string, priority: number) { await within(this.q.add('run', { id }, { jobId: id, priority: Math.max(1, 100 - priority) }), 'add'); }
  async remove(id: string) {
    const job = await within(this.q.getJob(id), 'lookup');
    if (!job) return false;
    const st = await within(job.getState(), 'state');
    if (st !== 'prioritized' && st !== 'waiting' && st !== 'delayed') return false;
    try { await job.remove(); return true; } catch { return false; } // lost the race with a worker
  }
  async stats() { const c = await within(this.q.getJobCounts('waiting', 'prioritized', 'active'), 'stats'); return { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0 }; }
  async ping() { await within(this.conn.ping(), 'ping'); }
  async close() { await this.q.close(); await this.conn.quit().catch(() => undefined); }
}
