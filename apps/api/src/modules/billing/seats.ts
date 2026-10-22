import type { Env } from '../../config/env.js';

/**
 * What a team that pays per seat may choose: never fewer than the people it already has (members plus pending invitations,
 * `floor`), never fewer than the minimum, never more than the maximum. If an operator set the minimum above the maximum, the
 * maximum wins rather than leaving no valid choice.
 */
export function seatLimits(env: Pick<Env, 'TEAM_MIN_SEATS' | 'TEAM_MAX_SEATS'>, floor = 0): { min: number; max: number } {
  const max = Math.max(1, env.TEAM_MAX_SEATS);
  return { min: Math.min(max, Math.max(1, env.TEAM_MIN_SEATS, floor)), max };
}
