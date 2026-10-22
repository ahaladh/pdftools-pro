import { mkdir, rm, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { ToolError, processTool, processToolIsolated } from '@pdftools/pdf-core';
import type { Env } from '../../config/env.js';
import { newId } from '../../utils/security.js';
import type { UsageStore } from '../usage/store.js';
import type { Metrics } from '../../ops/metrics.js';
import type { JobRecord, JobStore } from './types.js';

const SECRET_KEYS = ['password', 'ownerPassword'];
const scrub = (o: unknown) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([k]) => !SECRET_KEYS.includes(k))) : o);
const HEARTBEAT_MS = 2000;

/**
 * Executes one job end to end. Used by the in-process queue and by standalone worker processes, so
 * all state lives in the JobStore (MongoDB in multi-process deployments), never in this object.
 */
export class JobRunner {
  private running = new Map<string, { ac: AbortController; startedAt: number; tool: string; plan: string }>();

  constructor(private env: Env, private store: JobStore, private usage: UsageStore, private log: Logger, private metrics?: Metrics) {}

  runningSnapshot() { return [...this.running.entries()].map(([id, r]) => ({ id, tool: r.tool, plan: r.plan, runningMs: Date.now() - r.startedAt })); }
  get activeCount() { return this.running.size; }
  /** Abort a job running in THIS process (cross-process cancellation goes through cancelRequested). */
  abortLocal(id: string) { this.running.get(id)?.ac.abort(); }

  async process(id: string): Promise<void> {
    // Atomic claim: duplicates (queue retries, two workers) cannot both run the same job.
    const job = await this.store.transition(id, ['queued'], { state: 'processing', progress: 5, heartbeatAt: Date.now() });
    if (!job) return;
    const startedAt = Date.now();
    const ac = new AbortController();
    this.running.set(id, { ac, startedAt: Date.now(), tool: job.tool, plan: job.plan });
    const workDir = join(job.dir, 'work');
    let outcome: Partial<JobRecord> = { state: 'failed', error: { code: 'internal_error', message: 'Something went wrong while processing your file.' } };
    // Heartbeat proves liveness to the reaper and doubles as the cross-process cancel poll.
    const beat = setInterval(() => {
      void (async () => {
        const cur = await this.store.update(id, { heartbeatAt: Date.now() });
        if (cur?.cancelRequested) ac.abort();
      })().catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      // A batch gets the single-file time for each file, up to BATCH_TIMEOUT_FACTOR files' worth for the whole job.
      const fileTimeoutMs = this.env.JOB_TIMEOUT_SECONDS * 1000;
      const factor = job.batch ? Math.max(1, Math.min(job.inputs.length, this.env.BATCH_TIMEOUT_FACTOR)) : 1;
      const timeoutMs = fileTimeoutMs * factor;
      const iso = Math.max(1536, this.env.ISOLATION_MEMORY_MB);
      // A child process cannot raise a limit its parent was given, so engine caps are clamped to the job process cap.
      const limits = {
        memoryMB: Math.min(this.env.ENGINE_MEMORY_MB, iso), officeMemoryMB: Math.min(this.env.ENGINE_OFFICE_MEMORY_MB, iso),
        cpuSeconds: this.env.ENGINE_CPU_SECONDS, fileMB: this.env.ENGINE_MAX_FILE_MB,
      };
      const ctx = {
        workDir, inputs: job.inputs, options: job.options, signal: ac.signal, timeoutMs, maxPages: job.limits.maxPages, limits,
        ...(job.batch ? { batch: true, fileTimeoutMs } : {}),
        onProgress: (p: number) => void this.store.update(id, { progress: p }).catch(() => undefined),
      };
      const res = this.env.ISOLATE_JOBS
        ? await processToolIsolated(job.tool, ctx, { memoryMB: iso, cpuSeconds: this.env.ENGINE_CPU_SECONDS * 2 * factor, fileMB: this.env.ENGINE_MAX_FILE_MB })
        : await processTool(job.tool, ctx);
      if (ac.signal.aborted) throw new ToolError('cancelled', 'Job was cancelled');

      const outDir = join(job.dir, 'out');
      await mkdir(outDir, { recursive: true, mode: 0o700 });
      const fileId = newId(24);
      const finalPath = join(outDir, fileId);
      await rename(res.path, finalPath);
      const bytes = (await stat(finalPath)).size;
      if (bytes === 0) throw new ToolError('engine_failed', 'The result file was empty.');
      outcome = { state: 'completed', progress: 100, warnings: res.warnings, stats: res.stats, result: { fileId, name: res.name, mime: res.mime, bytes, path: finalPath } };
    } catch (e) {
      const cancelled = ac.signal.aborted || (e instanceof ToolError && e.code === 'cancelled');
      const err = e instanceof ToolError ? { code: e.code, message: e.message }
        : { code: 'internal_error', message: 'Something went wrong while processing your file.' };
      if (!(e instanceof ToolError)) this.log.error({ jobId: id, tool: job.tool, err: e }, 'job crashed');
      else this.log.warn({ jobId: id, tool: job.tool, code: e.code, detail: (e as { detail?: string }).detail }, 'job failed');
      outcome = cancelled ? { state: 'cancelled', error: { code: 'cancelled', message: 'Job was cancelled' } } : { state: 'failed', error: err };
    }
    // The job stays in `running` (and keeps its heartbeat) until cleanup AND the outcome are done: graceful shutdown
    // waits on `running`, so dropping the entry earlier lets the process exit with files left behind and the job
    // still marked as processing.
    try {
      // Source documents and scratch files are deleted BEFORE the outcome is published, so a client that sees a
      // terminal state can rely on the originals being gone. Passwords are scrubbed in the same step.
      await rm(join(job.dir, 'in'), { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
      const done = await this.store.transition(id, ['processing'], { ...outcome, options: scrub(job.options) as JobRecord['options'] });
      if (done && this.metrics) {
        this.metrics.jobsTotal.inc({ tool: job.tool, outcome: String(outcome.state) });
        this.metrics.jobDuration.observe({ tool: job.tool }, (Date.now() - startedAt) / 1000);
        if (outcome.state === 'failed') this.metrics.jobFailures.inc({ code: outcome.error?.code ?? 'unknown' });
      }
      // If another actor (e.g. the reaper) already finalised the job, secrets must still not outlive processing.
      if (!done) await this.store.update(id, { options: scrub(job.options) as JobRecord['options'] }).catch(() => undefined);
      if (done && outcome.state === 'completed') {
        // A batch counts one operation per file that was actually processed.
        const ops = job.batch ? Number((outcome.stats as { processed?: number } | undefined)?.processed ?? 1) : 1;
        await this.usage.increment(job.usageKeys, job.tool, undefined, ops).catch((e) => this.log.error({ err: e }, 'usage increment failed'));
        this.log.info({ jobId: id, tool: job.tool, bytes: (outcome.result as { bytes: number }).bytes }, 'job completed');
      }
    } finally {
      clearInterval(beat);
      this.running.delete(id);
    }
  }
}
