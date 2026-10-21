import { Router } from 'express';
import os from 'node:os';
import { z } from 'zod';
import { appSettingsSchema, PLAN_IDS } from '@pdftools/shared';
import { AuditModel, SessionModel, UsageModel, UserModel } from '../../db/models.js';
import { ok, wrap } from '../../middleware/common.js';
import { HttpError } from '../../utils/errors.js';
import type { AuditService } from '../auth/audit.js';
import { requireAdmin, requireAdminTwoFactor } from '../auth/middleware.js';
import type { Env } from '../../config/env.js';
import { adminTwoFactorRequired } from '../auth/policy.js';
import type { AuthService } from '../auth/service.js';
import { secondFactorOn, userView } from '../auth/service.js';
import type { JobService } from '../jobs/service.js';
import type { MongoJobStore } from '../jobs/mongo-store.js';
import type { SettingsService } from '../settings/service.js';

const page = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
/** Each operation is recorded under more than one key (a guest's cookie and IP; a team member's share of the pool). Count it once. */
const COUNTED_KEYS = { $not: /^(ip|tm):/ };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function adminRoutes(deps: { env: Env; jobs: JobService; jobStore: MongoJobStore; settings: SettingsService; audit: AuditService; auth: AuthService }) {
  const r = Router();
  r.use(requireAdmin); // every admin endpoint: authenticated AND role=admin, checked server-side
  r.use(requireAdminTwoFactor(deps.env)); // ...and, when the policy is on, protected by a second sign-in step

  r.get('/dashboard', wrap(async (_req, res) => {
    const since = new Date(Date.now() - 7 * 86400_000);
    const [total, active7d, admins, adminsWithoutTwoFactor, byPlanRows, states] = await Promise.all([
      UserModel.countDocuments(), UserModel.countDocuments({ lastLoginAt: { $gte: since } }), UserModel.countDocuments({ role: 'admin' }),
      UserModel.countDocuments({ role: 'admin', 'twoFactor.enabledAt': { $exists: false }, 'securityKeys.0': { $exists: false } }),
      UserModel.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }]) as Promise<{ _id: string; n: number }[]>,
      deps.jobStore.countsByState(),
    ]);
    const mem = process.memoryUsage();
    ok(res, {
      users: { total, active7d, admins, adminsWithoutTwoFactor, twoFactorRequired: adminTwoFactorRequired(deps.env), byPlan: Object.fromEntries(byPlanRows.map((p) => [p._id, p.n])) },
      jobs: { total: Object.values(states).reduce((a, b) => a + b, 0), byState: states, completed: states.completed ?? 0, failed: states.failed ?? 0 },
      queue: await deps.jobs.queueStats().catch(() => ({ waiting: 0, active: 0, unavailable: true })),
      running: deps.jobs.runningSnapshot(), // CPU-intensive work currently executing
      storage: { bytes: await deps.jobs.storageBytes() },
      system: { loadavg: os.loadavg(), cpus: os.cpus().length, rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, freeMemBytes: os.freemem(), totalMemBytes: os.totalmem() },
    });
  }));

  r.get('/users', wrap(async (req, res) => {
    const { page: p, pageSize } = page.parse(req.query);
    const q = z.string().max(100).optional().parse(req.query.q);
    const filter = q ? { email: { $regex: escapeRe(q.toLowerCase()) } } : {};
    const [rows, total] = await Promise.all([UserModel.find(filter).sort({ createdAt: -1 }).skip((p - 1) * pageSize).limit(pageSize), UserModel.countDocuments(filter)]);
    ok(res, { rows: rows.map((u) => ({ ...userView(u), status: u.status, lastLoginAt: u.lastLoginAt?.toISOString() })), total, page: p, pageSize });
  }));

  /** For someone locked out of their authenticator and recovery codes. Signs the user out everywhere; audited with who did it. */
  r.post('/users/:id/2fa/reset', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, 'not_found', 'User not found');
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, 'not_found', 'User not found');
    if (String(user._id) === String(req.user._id)) throw new HttpError(409, 'cannot_reset_own', 'You cannot reset your own two-step sign-in from the admin area. Ask another administrator.');
    if (!secondFactorOn(user)) throw new HttpError(409, 'two_factor_off', 'This user has not turned on two-factor sign-in.');
    await deps.auth.adminResetTwoFactor(req, user);
    ok(res, userView(user));
  }));

  r.patch('/users/:id', wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, 'not_found', 'User not found');
    const patch = z.object({
      role: z.enum(['user', 'admin']).optional(), plan: z.enum(['free', 'pro', 'business']).optional(), status: z.enum(['active', 'disabled']).optional(),
    }).refine((v) => Object.keys(v).length > 0, 'Nothing to change').parse(req.body);
    if (id === String(req.user._id) && (patch.role === 'user' || patch.status === 'disabled')) {
      throw new HttpError(400, 'self_lockout', 'You cannot remove your own admin access or disable your own account.');
    }
    const user = await UserModel.findById(id);
    if (!user) throw new HttpError(404, 'not_found', 'User not found');
    const before = { role: user.role, plan: user.plan, status: user.status };
    Object.assign(user, patch);
    await user.save();
    if (patch.status === 'disabled') await SessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await deps.audit.record(`u:${req.user._id}`, 'admin.user_updated', { target: `u:${id}`, req, meta: { before, after: patch } });
    ok(res, userView(user));
  }));

  r.get('/jobs', wrap(async (req, res) => {
    const q = page.extend({ state: z.string().max(20).optional(), tool: z.string().max(40).optional(), owner: z.string().max(60).optional() }).parse(req.query);
    const { rows, total } = await deps.jobStore.query(q);
    ok(res, {
      total, page: q.page, pageSize: q.pageSize,
      // Deliberately omits file paths, filenames and options.
      rows: rows.map((j) => ({ id: j.id, owner: j.owner, tool: j.tool, state: j.state, plan: j.plan, createdAt: new Date(j.createdAt).toISOString(), error: j.error?.code, bytes: j.result?.bytes })),
    });
  }));

  r.get('/usage', wrap(async (req, res) => {
    const days = z.coerce.number().int().min(1).max(90).default(14).parse(req.query.days);
    const from = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
    const rows = (await UsageModel.aggregate([{ $match: { day: { $gte: from }, key: COUNTED_KEYS } }, { $group: { _id: '$day', ops: { $sum: '$ops' }, owners: { $sum: 1 } } }, { $sort: { _id: 1 } }])) as { _id: string; ops: number; owners: number }[];
    const tools = (await UsageModel.aggregate([{ $match: { day: { $gte: from }, key: COUNTED_KEYS } }, { $project: { t: { $objectToArray: '$byTool' } } }, { $unwind: '$t' }, { $group: { _id: '$t.k', ops: { $sum: '$t.v' } } }, { $sort: { ops: -1 } }, { $limit: 20 }])) as { _id: string; ops: number }[];
    ok(res, { days: rows.map((x) => ({ day: x._id, ops: x.ops, activeOwners: x.owners })), topTools: tools.map((t) => ({ tool: t._id, ops: t.ops })) });
  }));

  r.get('/settings', wrap(async (_req, res) => ok(res, await deps.settings.get())));
  r.put('/settings', wrap(async (req, res) => {
    const next = appSettingsSchema.parse(req.body);
    for (const id of PLAN_IDS) if (next.plans[id].id !== id) throw new HttpError(400, 'invalid_settings', `Plan key ${id} does not match its id.`);
    const before = await deps.settings.get();
    const saved = await deps.settings.update(next);
    await deps.audit.record(`u:${req.user._id}`, 'admin.settings_updated', { req, meta: { maintenance: [before.maintenance, saved.maintenance], disabledTools: saved.disabledTools } });
    ok(res, saved);
  }));

  r.get('/audit', wrap(async (req, res) => {
    const q = page.extend({ actor: z.string().max(60).optional(), action: z.string().max(60).optional() }).parse(req.query);
    const filter: Record<string, string> = {};
    if (q.actor) filter.actor = q.actor;
    if (q.action) filter.action = q.action;
    const [rows, total] = await Promise.all([AuditModel.find(filter).sort({ at: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(), AuditModel.countDocuments(filter)]);
    ok(res, { rows, total, page: q.page, pageSize: q.pageSize });
  }));
  return r;
}
