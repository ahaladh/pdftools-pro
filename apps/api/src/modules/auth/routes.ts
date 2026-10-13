import { Router, type Response } from 'express';
import { forgotSchema, loginSchema, registerSchema, resetSchema } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { ok, wrap } from '../../middleware/common.js';
import { HttpError } from '../../utils/errors.js';
import { requireCsrfHeader } from './middleware.js';
import type { AuthService, Session } from './service.js';

const REFRESH_COOKIE = 'pt_refresh';

export const setRefreshCookie = (env: Env, res: Response, s: Session) =>
  res.cookie(REFRESH_COOKIE, s.refresh.token, { httpOnly: true, sameSite: 'strict', secure: env.NODE_ENV === 'production', expires: s.refresh.expires, path: '/api/auth' });

export function authRoutes(env: Env, auth: AuthService) {
  const r = Router();
  const respond = (res: Response, s: Session, status = 200) => {
    setRefreshCookie(env, res, s);
    ok(res, { user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn }, status);
  };

  r.post('/register', wrap(async (req, res) => respond(res, await auth.register(req, registerSchema.parse(req.body)), 201)));
  r.post('/login', wrap(async (req, res) => { const b = loginSchema.parse(req.body); respond(res, await auth.login(req, b.email, b.password)); }));

  r.post('/refresh', requireCsrfHeader, wrap(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string') throw new HttpError(401, 'invalid_session', 'Please sign in.');
    try { respond(res, await auth.refresh(req, token)); }
    catch (e) { res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' }); throw e; }
  }));

  r.post('/logout', requireCsrfHeader, wrap(async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    ok(res, { loggedOut: true });
  }));

  r.post('/forgot-password', wrap(async (req, res) => {
    await auth.forgotPassword(req, forgotSchema.parse(req.body).email);
    ok(res, { message: 'If an account exists for that email, a reset link has been sent.' });
  }));
  r.post('/reset-password', wrap(async (req, res) => { const b = resetSchema.parse(req.body); await auth.resetPassword(req, b.token, b.password); ok(res, { reset: true }); }));
  return r;
}
