import type { PlanId, TeamRole } from '@pdftools/shared';
import { MemberModel, TeamModel } from '../../db/models.js';
import type { UserDoc } from '../auth/service.js';

const RANK: Record<string, number> = { guest: 0, free: 1, pro: 2, business: 3 };
export const better = (a: PlanId, b: PlanId): PlanId => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

/**
 * Operations are counted against one shared pool when a team's paid plan covers the person (the team plan is at least as
 * good as their own). The pool is `dailyOps x members` for the day: members who use less leave room for those who use more.
 */
export interface PoolContext { teamId: string; teamName: string; /** Usage key of the shared counter. */ key: string; members: number; /** Everyone in the team, so jobs in flight anywhere in it count against the pool. */ memberIds: string[] }
export const poolKey = (teamId: string) => `t:${teamId}`;
/** Per-member breakdown of the pool (for the team's owners, and so a member can see their own share). */
export const memberKey = (teamId: string, userId: string) => `tm:${teamId}:${userId}`;

export interface TeamContext { id: string; name: string; role: TeamRole; plan: PlanId }

/** The team this person belongs to, if any. One indexed lookup for the membership and one for the team. */
export async function teamOf(userId: unknown): Promise<TeamContext | null> {
  const m = await MemberModel.findOne({ userId }).lean<{ teamId: unknown; role: TeamRole }>();
  if (!m) return null;
  const t = await TeamModel.findById(m.teamId).lean<{ _id: unknown; name: string; plan: PlanId }>();
  return t ? { id: String(t._id), name: t.name, role: m.role, plan: t.plan } : null;
}

/**
 * The plan that applies to this person: the better of their own and their team's. Computed on every request, so removing
 * someone from a team, or the team's subscription ending, takes effect immediately with nothing to clean up.
 */
export async function planInfo(user: UserDoc): Promise<{ effectivePlan: PlanId; team?: TeamContext; pool?: PoolContext }> {
  const team = await teamOf(user._id);
  if (!team) return { effectivePlan: user.plan as PlanId };
  const pooled = team.plan !== 'free' && (RANK[team.plan] ?? 0) >= (RANK[user.plan] ?? 0);
  const memberIds = pooled ? (await MemberModel.find({ teamId: team.id }).select('userId').lean<{ userId: unknown }[]>()).map((m) => String(m.userId)) : [];
  const pool: PoolContext | undefined = pooled
    ? { teamId: team.id, teamName: team.name, key: poolKey(team.id), members: Math.max(1, memberIds.length), memberIds }
    : undefined;
  return { effectivePlan: better(user.plan as PlanId, team.plan), team, ...(pool ? { pool } : {}) };
}
