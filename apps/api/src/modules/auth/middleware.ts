import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Env } from '../../config/env.js';
import { UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import { newId } from '../../utils/security.js';
import { verifyAccessToken } from './tokens.js';
import type { UserDoc } from './service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Authenticated account (undefined for guests). */
    user?: UserDoc;
    /** Counter keys for quota accounting: user id, or guest cookie + client IP. */
    usageKeys: string[];
  }
}

const GUEST_COOKIE = 'pt_guest';

/**
 * Resolve who is calling. A valid Bearer access token makes the caller that user; an invalid or
 * expired one is a 401 (so the client refreshes); no token means a guest identified by cookie.
 */
export function identity(env: Env, accountsEnabled: boolean): RequestHandler {
  return async (req, res, next) => {
    try {
      const auth = req.get('authorization');
      if (auth?.startsWith('Bearer ')) {
        if (!accountsEnabled) throw new HttpError(401, 'accounts_disabled', 'Accounts are not enabled.');
        const id = await verifyAccessToken(env.JWT_ACCESS_SECRET, auth.slice(7));
        const user = id ? await UserModel.findById(id).catch(() => null) : null;
        if (!user || user.status !== 'active') throw new HttpError(401, 'invalid_token', 'Session expired. Please sign in again.');
        req.user = user;
        req.owner = `u:${user._id}`;
        req.usageKeys = [req.owner];
        return next();
      }
      let id: unknown = req.cookies?.[GUEST_COOKIE];
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
        id = newId(16);
        res.cookie(GUEST_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 30 * 24 * 3600 * 1000, path: '/' });
      }
      req.owner = `g:${id as string}`;
      // Cookies are trivially cleared, so guest quotas also count the client IP.
      req.usageKeys = [req.owner, `ip:${req.ip ?? 'unknown'}`];
      next();
    } catch (e) { next(e); }
  };
}

export const requireUser: RequestHandler = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'auth_required', 'Please sign in.')));
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'auth_required', 'Please sign in.'));
  // Role is read from the database on every request, never trusted from the token.
  if (req.user.role !== 'admin') return next(new HttpError(403, 'forbidden', 'Administrator access required.'));
  next();
};

/** Cookie-authenticated endpoints must carry a header a cross-site form cannot set. */
export const requireCsrfHeader: RequestHandler = (req: Request, _res: Response, next: NextFunction) =>
  req.get('x-pdftools-csrf') === '1' ? next() : next(new HttpError(403, 'csrf', 'Missing CSRF header.'));
