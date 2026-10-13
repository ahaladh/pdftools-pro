import { Router } from 'express';
import { HttpError } from '../../utils/errors.js';
import { ok, wrap } from '../../middleware/common.js';
import type { JobService } from './service.js';

export function jobRoutes(jobs: JobService) {
  const r = Router();
  /** Ownership failures return 404, not 403, so job ids cannot be probed. */
  const load = async (id: string, owner: string) => {
    const job = /^[a-f0-9]{32}$/.test(id) ? await jobs.store.get(id) : undefined;
    if (!job || job.owner !== owner) throw new HttpError(404, 'not_found', 'Job not found');
    return job;
  };

  r.get('/:jobId', wrap(async (req, res) => ok(res, jobs.view(await load(String(req.params.jobId), req.owner)))));

  r.post('/:jobId/cancel', wrap(async (req, res) => {
    const job = await load(String(req.params.jobId), req.owner);
    const updated = await jobs.cancel(job);
    ok(res, jobs.view(updated ?? job));
  }));
  return r;
}
