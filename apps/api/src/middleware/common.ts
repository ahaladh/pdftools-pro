import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import type { Logger } from 'pino';
import { HttpError } from '../utils/errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Stable principal for ownership checks: "g:<guestId>" now, "u:<userId>" once accounts land. */
    owner: string;
  }
}

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export const ok = <T>(res: Response, data: T, status = 200) => res.status(status).json({ ok: true, data });

export function notFound(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(404, 'not_found', 'Resource not found'));
}

export function errorHandler(log: Logger, onError?: (code: string, status: number) => void) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500, code = 'internal_error', message = 'Unexpected server error', details: unknown;
    if (err instanceof HttpError) ({ status, code, message, details } = err);
    else if (err instanceof ZodError) { status = 400; code = 'invalid_request'; message = 'Invalid request'; details = err.issues; }
    else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_error';
      message = err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the maximum allowed size' : `Upload rejected (${err.code})`;
    } else if ((err as { type?: string }).type === 'entity.too.large') { status = 413; code = 'payload_too_large'; message = 'Request too large'; }
    else if ((err as { type?: string }).type === 'entity.parse.failed') { status = 400; code = 'invalid_json'; message = 'Malformed JSON body'; }
    if (status >= 500) log.error({ err, path: req.path }, 'unhandled error');
    onError?.(code, status);
    res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  };
}
