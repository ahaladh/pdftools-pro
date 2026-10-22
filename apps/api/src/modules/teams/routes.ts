import { Router } from 'express';
import { acceptInviteSchema, createTeamSchema, inviteSchema, memberRoleSchema, renameTeamSchema, teamSettingsSchema, transferSchema } from '@pdftools/shared';
import { ok, wrap } from '../../middleware/common.js';
import { requireUser } from '../auth/middleware.js';
import type { TeamService } from './service.js';

/** Every route needs a signed-in user; what they may do depends on their role in THEIR team (there is no team id in any URL to tamper with). */
export function teamRoutes(teams: TeamService) {
  const r = Router();
  r.use(requireUser);
  r.get('/mine', wrap(async (req, res) => ok(res, await teams.view(req.user))));
  r.post('/', wrap(async (req, res) => { await teams.create(req, req.user, createTeamSchema.parse(req.body).name); ok(res, await teams.view(req.user), 201); }));
  r.patch('/mine', wrap(async (req, res) => { await teams.rename(req, req.user, renameTeamSchema.parse(req.body).name); ok(res, await teams.view(req.user)); }));
  r.patch('/mine/settings', wrap(async (req, res) => { await teams.setMemberCap(req, req.user, teamSettingsSchema.parse(req.body).memberDailyCap); ok(res, await teams.view(req.user)); }));
  r.delete('/mine', wrap(async (req, res) => { await teams.deleteTeam(req, req.user); ok(res, { deleted: true }); }));

  r.post('/mine/invites', wrap(async (req, res) => { const b = inviteSchema.parse(req.body); await teams.invite(req, req.user, b.email, b.role); ok(res, await teams.view(req.user), 201); }));
  r.delete('/mine/invites/:id', wrap(async (req, res) => { await teams.cancelInvite(req, req.user, String(req.params.id)); ok(res, await teams.view(req.user)); }));
  r.post('/invites/accept', wrap(async (req, res) => { await teams.accept(req, req.user, acceptInviteSchema.parse(req.body).token); ok(res, await teams.view(req.user)); }));

  r.patch('/mine/members/:userId', wrap(async (req, res) => { await teams.setRole(req, req.user, String(req.params.userId), memberRoleSchema.parse(req.body).role); ok(res, await teams.view(req.user)); }));
  r.delete('/mine/members/:userId', wrap(async (req, res) => { await teams.removeMember(req, req.user, String(req.params.userId)); ok(res, await teams.view(req.user)); }));
  r.post('/mine/leave', wrap(async (req, res) => { await teams.leave(req, req.user); ok(res, { left: true }); }));
  r.post('/mine/transfer', wrap(async (req, res) => { await teams.transfer(req, req.user, transferSchema.parse(req.body).userId); ok(res, await teams.view(req.user)); }));
  return r;
}
