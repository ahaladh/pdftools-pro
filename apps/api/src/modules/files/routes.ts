import { Router } from 'express';
import { createReadStream } from 'node:fs';
import type { Env } from '../../config/env.js';
import { HttpError } from '../../utils/errors.js';
import { safeFilename, verifyDownload } from '../../utils/security.js';
import { ok, wrap } from '../../middleware/common.js';
import type { JobService } from '../jobs/service.js';

export function fileRoutes(env: Env, jobs: JobService) {
  const r = Router();
  const validId = (id: string) => /^[a-f0-9]{48}$/.test(id);

  // Authorization = valid short-lived signed token (issued only to the job owner) AND ownership.
  r.get('/:fileId/download', wrap(async (req, res) => {
    const fileId = String(req.params.fileId);
    if (!validId(fileId) || !verifyDownload(env.DOWNLOAD_SECRET, fileId, String(req.query.token ?? ''))) {
      throw new HttpError(403, 'invalid_link', 'This download link is invalid or has expired.');
    }
    const job = await jobs.store.getByFileId(fileId);
    if (!job || job.owner !== req.owner || job.state !== 'completed' || !job.result) throw new HttpError(404, 'not_found', 'File not found');
    const name = safeFilename(job.result.name, 'download');
    res.setHeader('Content-Type', job.result.mime);
    res.setHeader('Content-Length', String(job.result.bytes));
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(job.result.path).on('error', () => res.destroy()).pipe(res);
  }));

  r.delete('/:fileId', wrap(async (req, res) => {
    const fileId = String(req.params.fileId);
    const job = validId(fileId) ? await jobs.store.getByFileId(fileId) : undefined;
    if (!job || job.owner !== req.owner) throw new HttpError(404, 'not_found', 'File not found');
    await jobs.expire(job, 'user');
    ok(res, { deleted: true });
  }));
  return r;
}
