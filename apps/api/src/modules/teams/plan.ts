import type { PlanId, TeamRole } from '@pdftools/shared';
import { MemberModel, TeamModel } from '../../db/models.js';
import type { UserDoc } from '../auth/service.js';

const RANK: Record<string, number> = { guest: 0, free: 1, pro: 2, business: 3 };
export const better = (a: PlanId, b: PlanId): PlanId => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

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
export async function planInfo(user: UserDoc): Promise<{ effectivePlan: PlanId; team?: TeamContext }> {
  const team = await teamOf(user._id);
  return { effectivePlan: team ? better(user.plan as PlanId, team.plan) : (user.plan as PlanId), ...(team ? { team } : {}) };
}
