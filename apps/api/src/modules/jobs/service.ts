import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { JobView, ToolId } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { newId, signDownload } from '../../utils/security.js';
import { dirSize } from '../../utils/fs.js';
import type { Metrics } from '../../ops/metrics.js';
import type { JobQueue } from './queue.js';
import type { JobRunner } from './runner.js';
import type { JobRecord, JobStore } from './types.js';

const ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * Owns the job lifecycle on the API side: allocate -> submit (store + queue) -> cancel -> expire,
 * plus housekeeping (retention sweep, crash reaper, orphan cleanup). Actual processing is done by a
 * JobRunner, either in this process (InlineQueue) or in separate workers (BullQueue).
 */
export class JobService {
  readonly root: string;
  private storageCache: { at: number; bytes: number } | null = null;

  constructor(private env: Env, readonly store: JobStore, private log: Logger, readonly queue: JobQueue, readonly runner: JobRunner | null, private metrics?: Metrics) {
    this.root = resolve(env.STORAGE_DIR, 'jobs');
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanOrphans();
  }

  queueStats() { return this.queue.stats(); }
  runningSnapshot() { return this.runner?.runningSnapshot() ?? []; }

  /** Bytes currently stored (cached briefly). Used for the storage cap and the admin dashboard. */
  async storageBytes(): Promise<number> {
    if (!this.storageCache || Date.now() - this.storageCache.at > this.env.STORAGE_CACHE_SECONDS * 1000) this.storageCache = { at: Date.now(), bytes: await dirSize(this.root) };
    return this.storageCache.bytes;
  }

  /** Allocate a private directory for an upload before the job record exists. */
  async allocate(): Promise<{ id: string; dir: string }> {
    const id = newId(16);
    const dir = join(this.root, id);
    await mkdir(join(dir, 'in'), { recursive: true, mode: 0o700 });
    return { id, dir };
  }

  async discard(dir: string) { await rm(dir, { recursive: true, force: true }); }

  /**
   * Claim a job slot BEFORE the upload is read. The placeholder counts as active, so parallel uploads
   * cannot all slip past the concurrency/quota check (the caller serialises check + reserve per owner).
   */
  async reserve(rec: Pick<JobRecord, 'id' | 'owner' | 'tool' | 'dir' | 'plan' | 'priority' | 'limits' | 'usageKeys'>) {
    const now = Date.now();
    await this.store.create({ ...rec, state: 'uploading', progress: 0, options: {}, inputs: [], warnings: [], createdAt: now, expiresAt: now + 60 * 60_000 });
  }

  /** Drop a reservation whose upload was rejected or aborted. */
  async abandon(id: string, dir: string) {
    await this.store.delete(id).catch((e) => this.log.error({ err: e, jobId: id }, 'could not drop reservation'));
    await rm(dir, { recursive: true, force: true });
  }

  /** Turn a reservation into a queued job and enqueue it. */
  async submit(rec: Pick<JobRecord, 'id' | 'options' | 'inputs'> & { retentionMinutes: number }) {
    const now = Date.now();
    const job = await this.store.transition(rec.id, ['uploading'], { options: rec.options, inputs: rec.inputs, state: 'queued', createdAt: now, expiresAt: now + rec.retentionMinutes * 60_000 });
    if (!job) throw new Error('reservation vanished before submit');
    try { await this.queue.add(job.id, job.priority); }
    catch (e) {
      this.log.error({ err: e, jobId: job.id }, 'could not enqueue job');
      await this.store.update(job.id, { state: 'failed', error: { code: 'queue_unavailable', message: 'The processing queue is unavailable. Please try again shortly.' } });
      throw e;
    }
    return job;
  }

  async cancel(job: JobRecord): Promise<JobRecord | undefined> {
    if (job.state === 'queued') {
      const removed = await this.queue.remove(job.id);
      const t = await this.store.transition(job.id, ['queued'], { state: 'cancelled', error: { code: 'cancelled', message: 'Job was cancelled' } });
      if (t) { await rm(join(job.dir, 'in'), { recursive: true, force: true }); return t; }
      void removed; // a runner claimed it first: fall through to the processing path
    }
    const cur = await this.store.get(job.id);
    if (cur?.state === 'processing') {
      // Works for any runner in any process: it polls this flag with its heartbeat. Local runners abort at once.
      await this.store.update(job.id, { cancelRequested: true });
      this.runner?.abortLocal(job.id);
    }
    return this.store.get(job.id);
  }

  /** Remove files for a job and mark it expired. */
  async expire(job: JobRecord, reason: 'retention' | 'user') {
    await rm(job.dir, { recursive: true, force: true });
    await this.store.update(job.id, { state: 'expired', result: undefined });
    this.log.info({ jobId: job.id, reason }, 'job files deleted');
  }

  async sweep(now = Date.now()) {
    const due = await this.store.listExpired(now);
    for (const j of due) await this.expire(j, 'retention');
    // Crash recovery: jobs whose runner vanished, and jobs nobody ever picked up.
    const stale = await this.store.failStale(now, { heartbeatMs: this.env.HEARTBEAT_STALE_SECONDS * 1000, queueMs: this.env.QUEUE_TIMEOUT_SECONDS * 1000 });
    for (const j of stale) {
      this.log.warn({ jobId: j.id, code: j.error?.code }, 'stale job failed');
      this.metrics?.reaped.inc({ code: j.error?.code ?? 'unknown' });
      await rm(join(j.dir, 'in'), { recursive: true, force: true });
      await rm(join(j.dir, 'work'), { recursive: true, force: true });
    }
    return due.length + stale.length;
  }

  /** Delete directories that belong to no job record, but only once they are old enough that a job being created cannot own them. */
  async cleanOrphans(graceMs = ORPHAN_GRACE_MS) {
    let removed = 0;
    for (const d of await readdir(this.root)) {
      const p = join(this.root, d);
      const known = /^[a-f0-9]{32}$/.test(d) ? await this.store.get(d) : undefined;
      if (known) continue;
      const age = Date.now() - ((await stat(p).catch(() => null))?.mtimeMs ?? 0);
      if (age >= graceMs) { await rm(p, { recursive: true, force: true }); removed++; }
    }
    return removed;
  }

  startSweeper() {
    let tick = 0;
    const t = setInterval(() => {
      void (async () => { await this.sweep(); if (++tick % 10 === 0) await this.cleanOrphans(); })().catch((e) => this.log.error({ err: e }, 'sweep failed'));
    }, this.env.CLEANUP_INTERVAL_SECONDS * 1000);
    t.unref();
    return t;
  }

  view(job: JobRecord): JobView {
    const v: JobView = {
      id: job.id, tool: job.tool, state: job.state, progress: job.progress,
      createdAt: new Date(job.createdAt).toISOString(), expiresAt: new Date(job.expiresAt).toISOString(),
      warnings: job.warnings ?? [], error: job.error?.code ? job.error : undefined, stats: job.stats,
    };
    if (job.state === 'completed' && job.result) {
      const token = signDownload(this.env.DOWNLOAD_SECRET, job.result.fileId, this.env.DOWNLOAD_LINK_TTL_SECONDS);
      v.result = {
        fileId: job.result.fileId, name: job.result.name, mime: job.result.mime, bytes: job.result.bytes,
        downloadUrl: `/api/files/${job.result.fileId}/download?token=${token}`,
      };
    }
    return v;
  }
}

export type { ToolId };
