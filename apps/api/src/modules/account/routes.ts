import { Router } from 'express';
import { changePasswordSchema, profileSchema, reauthSchema, twoFactorConfirmSchema, twoFactorEnableSchema, type UsageView } from '@pdftools/shared';
import { z } from 'zod';
import { ok, wrap } from '../../middleware/common.js';
import { requireUser } from '../auth/middleware.js';
import { userView, type AuthService } from '../auth/service.js';
import type { JobService } from '../jobs/service.js';
import type { SettingsService } from '../settings/service.js';
import type { UsageStore } from '../usage/store.js';
import { today } from '../usage/store.js';

export function accountRoutes(deps: { auth: AuthService; jobs: JobService; usage: UsageStore; settings: SettingsService; refreshCookie: (res: import('express').Response, s: import('../auth/service.js').Session) => void }) {
  const r = Router();
  r.use(requireUser);

  r.get('/', wrap(async (req, res) => ok(res, userView(req.user))));

  r.patch('/', wrap(async (req, res) => {
    const { name } = profileSchema.parse(req.body);
    req.user.name = name;
    await req.user.save();
    ok(res, userView(req.user));
  }));

  r.post('/password', wrap(async (req, res) => {
    const b = changePasswordSchema.parse(req.body);
    const s = await deps.auth.changePassword(req, req.user, b.currentPassword, b.newPassword);
    deps.refreshCookie(res, s);
    ok(res, { user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn });
  }));

  // Two-factor sign-in. Every change asks for the password again; turning it on or off signs other devices out.
  r.post('/2fa/setup', wrap(async (req, res) => ok(res, await deps.auth.beginTwoFactor(req.user, reauthSchema.parse(req.body).password))));
  r.post('/2fa/enable', wrap(async (req, res) => {
    const { recoveryCodes, session } = await deps.auth.enableTwoFactor(req, req.user, twoFactorEnableSchema.parse(req.body).code);
    deps.refreshCookie(res, session);
    ok(res, { recoveryCodes, user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn });
  }));
  r.post('/2fa/disable', wrap(async (req, res) => {
    const b = twoFactorConfirmSchema.parse(req.body);
    const s = await deps.auth.disableTwoFactor(req, req.user, b.password, b.code);
    deps.refreshCookie(res, s);
    ok(res, { user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn });
  }));
  r.post('/2fa/recovery-codes', wrap(async (req, res) => {
    const b = twoFactorConfirmSchema.parse(req.body);
    ok(res, { recoveryCodes: await deps.auth.regenerateRecoveryCodes(req, req.user, b.password, b.code) });
  }));

  r.get('/usage', wrap(async (req, res) => {
    const plan = await deps.settings.plan(req.user.plan);
    const series = await deps.usage.series(`u:${req.user._id}`, 30);
    const view: UsageView = {
      plan: plan.id,
      today: { ops: series.find((d) => d.day === today())?.ops ?? 0, limit: plan.dailyOps },
      limits: { maxFileMB: plan.maxFileMB, maxPages: plan.maxPages, maxFiles: plan.maxFiles, maxConcurrentJobs: plan.maxConcurrentJobs, retentionMinutes: plan.retentionMinutes },
      last30Days: series,
    };
    ok(res, view);
  }));

  r.get('/jobs', wrap(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
    ok(res, (await deps.jobs.store.list(req.owner, limit)).map((j) => deps.jobs.view(j)));
  }));

  r.delete('/', wrap(async (req, res) => {
    const { password } = z.object({ password: z.string().min(1).max(128) }).parse(req.body);
    await deps.auth.deleteAccount(req, req.user, password);
    res.clearCookie('pt_refresh', { path: '/api/auth' });
    ok(res, { deleted: true });
  }));
  return r;
}
