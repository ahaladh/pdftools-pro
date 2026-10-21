import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Env } from '../../config/env.js';
import { UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import { newId } from '../../utils/security.js';
import { verifyAccessToken } from './tokens.js';
import { memberKey, planInfo } from '../teams/plan.js';
import { secondFactorOn, type UserDoc } from './service.js';
import { adminTwoFactorRequired } from './policy.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Authenticated account (undefined for guests). */
    user?: UserDoc;
    /** The plan that applies: their own or their team's, whichever is better (undefined for guests). */
    effectivePlan?: import('@pdftools/shared').PlanId;
    /** Set when this person's operations are counted against their team's shared daily pool. */
    pool?: import('../teams/plan.js').PoolContext;
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
        const info = await planInfo(user);
        req.effectivePlan = info.effectivePlan;
        req.owner = `u:${user._id}`;
        // Pooled: count against the team's shared counter (plus a per-member breakdown), not the person's own, so leaving the
        // team later does not leave them with a used-up personal allowance.
        if (info.pool) { req.pool = info.pool; req.usageKeys = [info.pool.key, memberKey(info.pool.teamId, String(user._id))]; }
        else req.usageKeys = [req.owner];
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

/**
 * Administrators must have a second sign-in step. Checked from the database on every request (never from the token), so
 * it applies the moment an account is promoted or its factors are removed. Account endpoints stay open so they can enrol.
 */
export const requireAdminTwoFactor = (env: Env): RequestHandler => (req, _res, next) => {
  if (adminTwoFactorRequired(env) && !secondFactorOn(req.user)) {
    return next(new HttpError(403, 'two_factor_required', 'Administrators must turn on two-step sign-in (an authenticator app or a security key) before using the admin area. Open your account page to set it up.'));
  }
  next();
};

/** Cookie-authenticated endpoints must carry a header a cross-site form cannot set. */
export const requireCsrfHeader: RequestHandler = (req: Request, _res: Response, next: NextFunction) =>
  req.get('x-pdftools-csrf') === '1' ? next() : next(new HttpError(403, 'csrf', 'Missing CSRF header.'));
