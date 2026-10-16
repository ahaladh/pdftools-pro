import { Router, type Response } from 'express';
import { forgotSchema, loginSchema, registerSchema, resetSchema, twoFactorLoginSchema, verifyEmailSchema } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { ok, wrap } from '../../middleware/common.js';
import { HttpError } from '../../utils/errors.js';
import { requireCsrfHeader, requireUser } from './middleware.js';
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
  r.post('/login', wrap(async (req, res) => {
    const b = loginSchema.parse(req.body);
    const s = await auth.login(req, b.email, b.password);
    if ('twoFactorRequired' in s) return ok(res, s); // password was right; no session or cookie until the second factor is too
    respond(res, s);
  }));
  r.post('/login/2fa', wrap(async (req, res) => { const b = twoFactorLoginSchema.parse(req.body); respond(res, await auth.completeTwoFactorLogin(req, b.challenge, b.code)); }));

  r.post('/verify-email', wrap(async (req, res) => { await auth.verifyEmail(req, verifyEmailSchema.parse(req.body).token); ok(res, { verified: true }); }));
  r.post('/resend-verification', requireUser, wrap(async (req, res) => { await auth.resendVerification(req, req.user); ok(res, { sent: true }); }));

  // Devices. Bearer-authenticated (so CSRF cannot reach them); the refresh cookie is only read to say which one is "this device".
  r.get('/sessions', requireUser, wrap(async (req, res) => ok(res, await auth.listSessions(req.user._id, req.cookies?.[REFRESH_COOKIE]))));
  r.post('/sessions/revoke-others', requireUser, wrap(async (req, res) => ok(res, { revoked: await auth.revokeOtherSessions(req, req.user._id, req.cookies?.[REFRESH_COOKIE]) })));
  r.delete('/sessions/:id', requireUser, wrap(async (req, res) => { await auth.revokeSession(req, req.user._id, String(req.params.id)); ok(res, { revoked: true }); }));

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
