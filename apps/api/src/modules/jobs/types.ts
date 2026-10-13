import type { JobState, PlanId, ToolId } from '@pdftools/shared';

export interface StoredInput { path: string; name: string; kind: 'pdf' | 'jpg' | 'png' | 'office'; }

export interface JobRecord {
  id: string;
  owner: string;           // "g:<guestId>" or "u:<userId>"
  tool: ToolId;
  state: JobState;
  progress: number;
  options: unknown;
  inputs: StoredInput[];
  dir: string;             // private job directory
  createdAt: number;
  expiresAt: number;
  error?: { code: string; message: string };
  warnings: string[];
  stats?: Record<string, number | string>;
  result?: { fileId: string; name: string; mime: string; bytes: number; path: string };
  plan: PlanId;
  /** Queue priority from the plan; higher runs first. */
  priority: number;
  limits: { maxPages: number };
  /** Usage counters to bump when the job completes (owner plus, for guests, the client IP). */
  usageKeys: string[];
  /** Last time a runner proved it is alive; used to detect crashed workers. */
  heartbeatAt?: number;
  /** Set by the API; the runner polls it and aborts. Works across processes. */
  cancelRequested?: boolean;
}

/** Persistence boundary. Memory implementation here; Mongo implementation is a production concern. */
export interface JobStore {
  create(job: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | undefined>;
  getByFileId(fileId: string): Promise<JobRecord | undefined>;
  update(id: string, patch: Partial<JobRecord>): Promise<JobRecord | undefined>;
  delete(id: string): Promise<void>;
  activeCount(owner: string): Promise<number>;
  listExpired(now: number): Promise<JobRecord[]>;
  list(owner: string, limit: number): Promise<JobRecord[]>;
  /** Atomically apply `patch` only if the job is currently in one of `from`. Returns the updated job, or undefined if the precondition failed. */
  transition(id: string, from: JobState[], patch: Partial<JobRecord>): Promise<JobRecord | undefined>;
  /** Atomically fail jobs whose runner stopped heartbeating or that sat in the queue too long. */
  failStale(now: number, opts: { heartbeatMs: number; queueMs: number }): Promise<JobRecord[]>;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>();
  async create(job: JobRecord) { this.jobs.set(job.id, job); }
  async get(id: string) { return this.jobs.get(id); }
  async getByFileId(fileId: string) {
    for (const j of this.jobs.values()) if (j.result?.fileId === fileId) return j;
    return undefined;
  }
  async update(id: string, patch: Partial<JobRecord>) {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    Object.assign(j, patch);
    return j;
  }
  async delete(id: string) { this.jobs.delete(id); }
  async activeCount(owner: string) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.owner === owner && (j.state === 'queued' || j.state === 'processing' || j.state === 'uploading')) n++;
    return n;
  }
  async listExpired(now: number) { return [...this.jobs.values()].filter((j) => j.expiresAt <= now && j.state !== 'expired' && j.state !== 'processing'); }
  async transition(id: string, from: JobState[], patch: Partial<JobRecord>) {
    const j = this.jobs.get(id);
    if (!j || !from.includes(j.state)) return undefined;
    Object.assign(j, patch);
    return j;
  }
  async failStale(now: number, o: { heartbeatMs: number; queueMs: number }) {
    const out: JobRecord[] = [];
    for (const j of this.jobs.values()) {
      if (j.state === 'processing' && now - (j.heartbeatAt ?? j.createdAt) > o.heartbeatMs) {
        Object.assign(j, { state: 'failed', error: { code: 'worker_lost', message: 'Processing was interrupted. Please try again.' } }); out.push(j);
      } else if ((j.state === 'queued' || j.state === 'uploading') && now - j.createdAt > o.queueMs) {
        Object.assign(j, { state: 'failed', error: { code: 'queue_timeout', message: 'The job waited too long and was dropped. Please try again.' } }); out.push(j);
      }
    }
    return out;
  }
  async list(owner: string, limit: number) {
    return [...this.jobs.values()].filter((j) => j.owner === owner).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
}
