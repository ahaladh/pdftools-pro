import type { Request } from 'express';
import type { Logger } from 'pino';
import type { PlanId, TeamInviteView, TeamMemberView, TeamRole, TeamView } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { InviteModel, MemberModel, TeamModel, UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import type { AuditService } from '../auth/audit.js';
import type { UserDoc } from '../auth/service.js';
import type { Mailer } from '../mail/mailer.js';
import { newOpaqueToken, sha256 } from '../auth/tokens.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = any;
const ACTIVE = new Set(['active', 'trialing', 'past_due']);
const isId = (s: string) => /^[a-f0-9]{24}$/.test(s);

export class TeamService {
  constructor(private env: Env, private mailer: Mailer, private audit: AuditService, private log: Logger,
    private hooks: { cancelSubscription: (team: Doc) => Promise<void> }) {}

  /** What the plan allows: members plus pending invitations. A team that is not paying has room only for its owner. */
  seatsFor(plan: PlanId): number { return plan === 'business' ? this.env.TEAM_SEATS_BUSINESS : plan === 'pro' ? this.env.TEAM_SEATS_PRO : 1; }

  private async mine(userId: unknown): Promise<{ team: Doc; member: Doc } | null> {
    const member = await MemberModel.findOne({ userId });
    if (!member) return null;
    const team = await TeamModel.findById(member.teamId);
    return team ? { team, member } : null;
  }
  /** The caller's team and their membership, or null. (Used by billing to find the team an owner pays for.) */
  async context(user: UserDoc): Promise<{ team: Doc; role: string } | null> { const c = await this.mine(user._id); return c ? { team: c.team, role: c.member.role } : null; }
  private async need(user: UserDoc) {
    const c = await this.mine(user._id);
    if (!c) throw new HttpError(404, 'no_team', 'You are not in a team.');
    return c;
  }
  private requireRole(member: Doc, allowed: TeamRole[], what: string) {
    if (!allowed.includes(member.role)) throw new HttpError(403, 'forbidden', `Only ${allowed.length === 1 ? `the team ${allowed[0]}` : 'team owners and admins'} can ${what}.`);
  }

  private async seatsUsed(teamId: unknown) { return (await MemberModel.countDocuments({ teamId })) + (await InviteModel.countDocuments({ teamId, expiresAt: { $gt: new Date() } })); }

  async view(user: UserDoc): Promise<TeamView | null> {
    const c = await this.mine(user._id);
    if (!c) return null;
    const { team, member } = c;
    const members = await MemberModel.find({ teamId: team._id }).sort({ createdAt: 1 });
    const users = new Map((await UserModel.find({ _id: { $in: members.map((m: Doc) => m.userId) } })).map((u: Doc) => [String(u._id), u]));
    const canManage = member.role === 'owner' || member.role === 'admin';
    const invites: TeamInviteView[] = canManage
      ? (await InviteModel.find({ teamId: team._id, expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 })).map((i: Doc) => ({ id: String(i._id), email: i.email, role: i.role, invitedAt: new Date(i.createdAt).toISOString(), expiresAt: new Date(i.expiresAt).toISOString() }))
      : [];
    const b = team.billing;
    return {
      id: String(team._id), name: team.name, myRole: member.role, plan: team.plan,
      seats: this.seatsFor(team.plan), seatsUsed: await this.seatsUsed(team._id),
      members: members.map((m: Doc): TeamMemberView => { const u = users.get(String(m.userId)); return { userId: String(m.userId), email: u?.email ?? '', name: u?.name ?? '', role: m.role, joinedAt: new Date(m.createdAt).toISOString(), you: String(m.userId) === String(user._id) }; }),
      invites,
      ...(member.role === 'owner' && b?.subscriptionId ? { subscription: { status: b.status, plan: b.plan, currentPeriodEnd: b.currentPeriodEnd?.toISOString(), cancelAtPeriodEnd: b.cancelAtPeriodEnd } } : {}),
      createdAt: new Date(team.createdAt).toISOString(),
    };
  }

  async create(req: Request, user: UserDoc, name: string): Promise<void> {
    if (await MemberModel.exists({ userId: user._id })) throw new HttpError(409, 'already_in_team', 'You are already in a team. Leave it first to create another.');
    const team = await TeamModel.create({ name, ownerId: user._id });
    try { await MemberModel.create({ teamId: team._id, userId: user._id, role: 'owner' }); }
    catch (e) {
      await TeamModel.deleteOne({ _id: team._id }); // lost a race with another create: the unique index on userId decided
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'already_in_team', 'You are already in a team. Leave it first to create another.');
      throw e;
    }
    await this.audit.record(`u:${user._id}`, 'team.created', { req, target: `t:${team._id}` });
  }

  async rename(req: Request, user: UserDoc, name: string) {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner', 'admin'], 'rename the team');
    team.name = name; await team.save();
    await this.audit.record(`u:${user._id}`, 'team.renamed', { req, target: `t:${team._id}` });
  }

  // ------------------------------------------------------------------ invitations
  async invite(req: Request, user: UserDoc, email: string, role: 'admin' | 'member') {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner', 'admin'], 'invite people');
    if (role === 'admin' && member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the team owner can invite an admin.');
    const existing = await UserModel.findOne({ email });
    if (existing && (await MemberModel.exists({ teamId: team._id, userId: existing._id }))) throw new HttpError(409, 'already_member', 'That person is already in your team.');
    // Say "already invited" before "no seats": a pending invitation holds a seat itself, and that is the more useful message.
    if (await InviteModel.exists({ teamId: team._id, email, expiresAt: { $gt: new Date() } })) throw new HttpError(409, 'already_invited', 'That address already has a pending invitation. Cancel it first to send a new one.');
    const seats = this.seatsFor(team.plan);
    if ((await this.seatsUsed(team._id)) >= seats) {
      throw new HttpError(409, 'no_seats', team.plan === 'free' ? 'This team has no free seats. Subscribe to a paid plan to add people.' : `All ${seats} seats on the ${team.plan} plan are taken (members and pending invitations). Remove someone or cancel an invitation first.`);
    }
    // An old, expired invitation for the same address would collide with the unique index: clear it.
    await InviteModel.deleteMany({ teamId: team._id, email, expiresAt: { $lte: new Date() } });
    const token = newOpaqueToken();
    let invite: Doc;
    try {
      invite = await InviteModel.create({ teamId: team._id, email, role, tokenHash: sha256(token), invitedBy: user._id, expiresAt: new Date(Date.now() + this.env.TEAM_INVITE_TTL_DAYS * 86400_000) });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'already_invited', 'That address already has a pending invitation. Cancel it first to send a new one.');
      throw e;
    }
    // Two invitations racing for the last seat can both pass the check above; recount and back out if we overshot (never oversubscribe).
    if ((await this.seatsUsed(team._id)) > seats) { await InviteModel.deleteOne({ _id: invite._id }); throw new HttpError(409, 'no_seats', 'No free seats are left.'); }
    const link = `${this.env.PUBLIC_URL.replace(/\/$/, '')}/team/join?token=${token}`;
    try {
      await this.mailer.send({ to: email, subject: `${user.name || user.email} invited you to join ${team.name} on ${this.env.BRAND_NAME}`, text: `You have been invited to join the team "${team.name}" as ${role === 'admin' ? 'an admin' : 'a member'}.\n\nSign in (or create an account) with this email address, confirm it, and open this link within ${this.env.TEAM_INVITE_TTL_DAYS} days:\n\n${link}\n\nIf you do not know this team, ignore this email.` });
    } catch (e) { this.log.error({ err: e }, 'could not send team invitation'); }
    await this.audit.record(`u:${user._id}`, 'team.invited', { req, target: `t:${team._id}`, meta: { role } });
  }

  async cancelInvite(req: Request, user: UserDoc, id: string) {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner', 'admin'], 'cancel invitations');
    const r = isId(id) ? await InviteModel.deleteOne({ _id: id, teamId: team._id }) : { deletedCount: 0 }; // scoped to MY team: another team's id is simply "not found"
    if (!r.deletedCount) throw new HttpError(404, 'not_found', 'That invitation no longer exists.');
    await this.audit.record(`u:${user._id}`, 'team.invite_cancelled', { req, target: `t:${team._id}` });
  }

  /** Join through an emailed link. The link alone is not enough: it must be opened by the invited address, confirmed. */
  async accept(req: Request, user: UserDoc, token: string): Promise<void> {
    const fail = () => new HttpError(400, 'invalid_invite', 'This invitation is invalid, expired or was already used.');
    const preview = await InviteModel.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
    if (!preview) throw fail();
    if (!user.emailVerifiedAt) throw new HttpError(403, 'email_unverified', 'Confirm your email address first, then open the invitation link again.');
    if (preview.email !== user.email) throw new HttpError(403, 'wrong_account', `This invitation was sent to a different email address. Sign in with the address it was sent to (${maskEmail(preview.email)}).`);
    if (await MemberModel.exists({ userId: user._id })) throw new HttpError(409, 'already_in_team', 'You are already in a team. Leave it before joining another.');
    const team = await TeamModel.findById(preview.teamId);
    if (!team) throw fail();
    // The invitation already holds a seat, but the plan may have shrunk since (subscription ended): members only.
    if ((await MemberModel.countDocuments({ teamId: team._id })) >= this.seatsFor(team.plan)) throw new HttpError(409, 'no_seats', 'This team has no free seats right now. Ask its owner to make room.');
    // Single use: exactly one caller can delete it.
    const claimed = await InviteModel.findOneAndDelete({ _id: preview._id });
    if (!claimed) throw fail();
    try { await MemberModel.create({ teamId: team._id, userId: user._id, role: claimed.role }); }
    catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'already_in_team', 'You are already in a team. Leave it before joining another.');
      throw e;
    }
    await this.audit.record(`u:${user._id}`, 'team.joined', { req, target: `t:${team._id}`, meta: { role: claimed.role } });
  }

  // ------------------------------------------------------------------ members
  async removeMember(req: Request, user: UserDoc, userId: string) {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner', 'admin'], 'remove people');
    if (!isId(userId)) throw new HttpError(404, 'not_found', 'That person is not in your team.');
    const target = await MemberModel.findOne({ teamId: team._id, userId });
    if (!target) throw new HttpError(404, 'not_found', 'That person is not in your team.');
    if (target.role === 'owner') throw new HttpError(403, 'forbidden', 'The owner cannot be removed. Transfer ownership first.');
    if (String(target.userId) === String(user._id)) throw new HttpError(400, 'use_leave', 'Use "Leave team" to remove yourself.');
    if (target.role === 'admin' && member.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the team owner can remove an admin.');
    await MemberModel.deleteOne({ _id: target._id });
    await this.audit.record(`u:${user._id}`, 'team.member_removed', { req, target: `u:${userId}`, meta: { team: String(team._id) } });
  }

  async setRole(req: Request, user: UserDoc, userId: string, role: 'admin' | 'member') {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner'], 'change roles');
    const target = isId(userId) ? await MemberModel.findOne({ teamId: team._id, userId }) : null;
    if (!target) throw new HttpError(404, 'not_found', 'That person is not in your team.');
    if (target.role === 'owner') throw new HttpError(400, 'owner_role', 'Use "Transfer ownership" to change the owner.');
    target.role = role; await target.save();
    await this.audit.record(`u:${user._id}`, 'team.role_changed', { req, target: `u:${userId}`, meta: { role } });
  }

  async leave(req: Request, user: UserDoc) {
    const { team, member } = await this.need(user);
    if (member.role === 'owner') throw new HttpError(409, 'owner_cannot_leave', 'You own this team. Transfer ownership to someone else, or delete the team.');
    await MemberModel.deleteOne({ _id: member._id });
    await this.audit.record(`u:${user._id}`, 'team.left', { req, target: `t:${team._id}` });
  }

  /** The new owner must already be in the team (and have a confirmed email: they now control billing). The old owner becomes an admin. */
  async transfer(req: Request, user: UserDoc, userId: string) {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner'], 'transfer ownership');
    const target = isId(userId) && userId !== String(user._id) ? await MemberModel.findOne({ teamId: team._id, userId }) : null;
    if (!target) throw new HttpError(404, 'not_found', 'Choose another member of your team.');
    const next = await UserModel.findById(userId);
    if (!next?.emailVerifiedAt) throw new HttpError(409, 'email_unverified', 'That person has not confirmed their email address yet, so they cannot take over billing.');
    target.role = 'owner'; member.role = 'admin';
    team.ownerId = target.userId;
    await Promise.all([target.save(), member.save(), team.save()]);
    await this.audit.record(`u:${user._id}`, 'team.ownership_transferred', { req, target: `u:${userId}`, meta: { team: String(team._id) } });
  }

  async deleteTeam(req: Request, user: UserDoc) {
    const { team, member } = await this.need(user);
    this.requireRole(member, ['owner'], 'delete the team');
    await this.destroy(team);
    await this.audit.record(`u:${user._id}`, 'team.deleted', { req, target: `t:${team._id}` });
  }

  /** Stop billing first: if Stripe cannot be reached, keep the team rather than leave a subscription nobody can manage. */
  private async destroy(team: Doc) {
    if (team.billing?.subscriptionId && ACTIVE.has(team.billing.status)) await this.hooks.cancelSubscription(team);
    await MemberModel.deleteMany({ teamId: team._id });
    await InviteModel.deleteMany({ teamId: team._id });
    await TeamModel.deleteOne({ _id: team._id });
  }

  /** Called before an account is deleted: leave quietly, or take a solo team with you. An owner with a team of others must hand it over first. */
  async onAccountDeletion(user: UserDoc) {
    const c = await this.mine(user._id);
    if (!c) return;
    if (c.member.role === 'owner') {
      if ((await MemberModel.countDocuments({ teamId: c.team._id })) > 1) throw new HttpError(409, 'transfer_required', 'You own a team that has other members. Transfer ownership (or delete the team) before deleting your account.');
      await this.destroy(c.team);
    } else await MemberModel.deleteOne({ _id: c.member._id });
  }
}

/** "a***@example.com": enough to recognise the address, not enough to learn it. */
export function maskEmail(e: string) { const [l, d] = e.split('@'); return `${l![0]}***@${d}`; }
