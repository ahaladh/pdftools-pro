import type { JobState } from '@pdftools/shared';
import { JobModel } from '../../db/models.js';
import type { JobRecord, JobStore } from './types.js';

const ACTIVE = ['queued', 'uploading', 'processing'];
const PURGE_AFTER_MS = 30 * 24 * 3600 * 1000;

const strip = (d: unknown): JobRecord | undefined => {
  if (!d) return undefined;
  const { _id, __v, purgeAt, ...rest } = d as Record<string, unknown>;
  void _id; void __v; void purgeAt;
  return rest as unknown as JobRecord;
};

export interface JobQuery { state?: string; tool?: string; owner?: string; page: number; pageSize: number }

export class MongoJobStore implements JobStore {
  async create(job: JobRecord) { await JobModel.create({ ...job, purgeAt: new Date(job.expiresAt + PURGE_AFTER_MS) }); }
  async get(id: string) { return strip(await JobModel.findOne({ id }).lean()); }
  async getByFileId(fileId: string) { return strip(await JobModel.findOne({ 'result.fileId': fileId }).lean()); }
  async update(id: string, patch: Partial<JobRecord>) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(patch)) (v === undefined ? $unset : $set)[k] = v === undefined ? '' : v;
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return strip(await JobModel.findOneAndUpdate({ id }, update, { new: true }).lean());
  }
  async delete(id: string) { await JobModel.deleteOne({ id }); }
  async activeCount(owner: string) { return JobModel.countDocuments({ owner, state: { $in: ACTIVE } }); }
  async listExpired(now: number) {
    const rows = await JobModel.find({ expiresAt: { $lte: now }, state: { $nin: ['expired', 'processing'] } }).limit(500).lean();
    return rows.map((r) => strip(r)!);
  }
  async list(owner: string, limit: number) {
    return (await JobModel.find({ owner }).sort({ createdAt: -1 }).limit(limit).lean()).map((r) => strip(r)!);
  }

  async transition(id: string, from: JobState[], patch: Partial<JobRecord>) {
    const $set: Record<string, unknown> = {}; const $unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(patch)) (v === undefined ? $unset : $set)[k] = v === undefined ? '' : v;
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return strip(await JobModel.findOneAndUpdate({ id, state: { $in: from } }, update, { new: true }).lean());
  }
  /** Each stale job is claimed with a conditional update, so concurrent reapers never double-fail one. */
  async failStale(now: number, o: { heartbeatMs: number; queueMs: number }) {
    const out: JobRecord[] = [];
    const beat = await JobModel.find({ state: 'processing', $or: [{ heartbeatAt: { $lt: now - o.heartbeatMs } }, { heartbeatAt: { $exists: false }, createdAt: { $lt: now - o.heartbeatMs } }] }).limit(200).lean();
    for (const j of beat) {
      const u = await this.transition((j as unknown as { id: string }).id, ['processing'], { state: 'failed', error: { code: 'worker_lost', message: 'Processing was interrupted. Please try again.' } });
      if (u) out.push(u);
    }
    const waiting = await JobModel.find({ state: { $in: ['queued', 'uploading'] }, createdAt: { $lt: now - o.queueMs } }).limit(200).lean();
    for (const j of waiting) {
      const u = await this.transition((j as unknown as { id: string }).id, ['queued', 'uploading'], { state: 'failed', error: { code: 'queue_timeout', message: 'The job waited too long and was dropped. Please try again.' } });
      if (u) out.push(u);
    }
    return out;
  }

  // --- admin ---
  async query(q: JobQuery) {
    const filter: Record<string, unknown> = {};
    if (q.state) filter.state = q.state;
    if (q.tool) filter.tool = q.tool;
    if (q.owner) filter.owner = q.owner;
    const [rows, total] = await Promise.all([
      JobModel.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
      JobModel.countDocuments(filter),
    ]);
    return { rows: rows.map((r) => strip(r)!), total };
  }
  async countsByState(): Promise<Record<string, number>> {
    const rows = (await JobModel.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }])) as { _id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }
  async deleteByOwner(owner: string) { await JobModel.deleteMany({ owner }); }
  async listByOwner(owner: string) { return (await JobModel.find({ owner }).lean()).map((r) => strip(r)!); }
}
