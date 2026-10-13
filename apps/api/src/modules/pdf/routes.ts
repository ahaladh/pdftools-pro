import { Router } from 'express';
import multer from 'multer';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { getTool, isToolId, optionSchemas } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { HttpError } from '../../utils/errors.js';
import { detectKind, detectOffice, newId, safeFilename } from '../../utils/security.js';
import { ok, wrap } from '../../middleware/common.js';
import { KeyedMutex } from '../../utils/mutex.js';
import type { JobService } from '../jobs/service.js';
import type { Entitlements } from '../usage/entitlements.js';
import type { StoredInput } from '../jobs/types.js';

declare module 'express-serve-static-core' {
  interface Request { allocation?: { id: string; dir: string } }
}

/** One generic endpoint per tool: POST /api/pdf/:tool (multipart: files[] + options JSON). */
export function pdfRoutes(env: Env, jobs: JobService, ent: Entitlements) {
  const r = Router();
  const reservations = new KeyedMutex();

  // multer instances are cached per (size, count) because limits come from the caller's plan.
  const uploaders = new Map<string, ReturnType<ReturnType<typeof multer>['array']>>();
  const uploaderFor = (maxFileMB: number, maxFiles: number) => {
    const key = `${maxFileMB}:${maxFiles}`;
    let u = uploaders.get(key);
    if (!u) {
      u = multer({
        storage: multer.diskStorage({
          destination: (req, _f, cb) => cb(null, join(req.allocation!.dir, 'in')),
          filename: (_req, _f, cb) => cb(null, newId(12)), // never use client-supplied names on disk
        }),
        limits: { fileSize: maxFileMB * 1024 * 1024, files: maxFiles, fields: 5, fieldSize: 5 * 1024 * 1024, parts: maxFiles + 6 },
      }).array('files', maxFiles);
      uploaders.set(key, u);
    }
    return u;
  };

  r.post('/:tool', wrap(async (req, res) => {
    const toolId = String(req.params.tool);
    const tool = getTool(toolId);
    if (!tool) throw new HttpError(404, 'unknown_tool', 'Unknown tool');
    if (tool.status !== 'available') throw new HttpError(501, 'not_implemented', `${tool.name} is not available yet.`);
    if (!isToolId(toolId)) throw new HttpError(404, 'unknown_tool', 'Unknown tool');

    // Maintenance, disabled tools, premium gating, daily quota and concurrency — all before reading the upload.
    // Check + slot reservation are one critical section per owner so parallel uploads cannot all pass the check.
    const { plan, alloc } = await reservations.run(req.owner, async () => {
      const plan = await ent.check(req, toolId);
      const alloc = await jobs.allocate();
      await jobs.reserve({ id: alloc.id, owner: req.owner, tool: toolId, dir: alloc.dir, plan: plan.id, priority: plan.priority, limits: { maxPages: plan.maxPages }, usageKeys: req.usageKeys });
      return { plan, alloc };
    });
    req.allocation = alloc;
    const { id, dir } = alloc;
    try {
      await new Promise<void>((resolve, reject) => uploaderFor(plan.maxFileMB, plan.maxFiles)(req, res, (e) => {
        if (!e) return resolve();
        // multer's own limit errors keep their specific mapping; anything else from the multipart parser
        // ("Malformed part header", truncated bodies, missing boundary...) is the client's fault, never a 500.
        reject(e instanceof multer.MulterError || e instanceof HttpError ? e : new HttpError(400, 'malformed_upload', 'The upload could not be read. Please try again.'));
      }));
      const files = (req.files ?? []) as Express.Multer.File[];
      if (files.length < tool.minFiles) throw new HttpError(400, 'not_enough_files', `${tool.name} needs at least ${tool.minFiles} file${tool.minFiles > 1 ? 's' : ''}.`);
      if (tool.maxFiles && files.length > tool.maxFiles) throw new HttpError(400, 'too_many_files', `${tool.name} accepts at most ${tool.maxFiles} files.`);
      if (!tool.multiple && files.length > 1) throw new HttpError(400, 'too_many_files', `${tool.name} accepts a single file.`);

      let options: unknown = {};
      const rawOptions = (req.body as Record<string, unknown> | undefined)?.options;
      if (typeof rawOptions === 'string' && rawOptions.trim()) {
        try { options = JSON.parse(rawOptions); } catch { throw new HttpError(400, 'invalid_options', 'options must be valid JSON'); }
      }
      const parsed = optionSchemas[toolId].safeParse(options);
      if (!parsed.success) throw new HttpError(400, 'invalid_options', 'Invalid tool options', parsed.error.issues);

      const inputs: StoredInput[] = [];
      for (const f of files) {
        if (f.size === 0) throw new HttpError(400, 'empty_file', `"${safeFilename(f.originalname)}" is empty.`);
        const fh = await open(f.path, 'r');
        const head = Buffer.alloc(1024);
        const { bytesRead } = await fh.read(head, 0, 1024, 0);
        await fh.close();
        let kind = detectKind(head.subarray(0, bytesRead));
        if (!kind && tool.accept.includes('office') && (await detectOffice(f.path, f.originalname))) kind = 'office';
        if (!kind || !tool.accept.includes(kind)) {
          throw new HttpError(415, 'unsupported_type', `"${safeFilename(f.originalname)}" is not a supported file type for ${tool.name}.`);
        }
        inputs.push({ path: f.path, name: safeFilename(f.originalname), kind });
      }

      const job = await jobs.submit({ id, options: parsed.data, inputs, retentionMinutes: plan.retentionMinutes }).catch((e) => { throw new HttpError(503, 'queue_unavailable', 'The processing queue is unavailable. Please try again shortly.', undefined, e); });
      ok(res, { jobId: job.id }, 202);
    } catch (e) {
      await jobs.abandon(id, dir);
      throw e;
    }
  }));

  return r;
}
