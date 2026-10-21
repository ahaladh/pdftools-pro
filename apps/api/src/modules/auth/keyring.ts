import type { Env } from '../../config/env.js';

/** The keys that protect authenticator secrets: the current one first (it seals), then earlier ones (they only open). */
export function twoFactorKeys(env: Pick<Env, 'TWO_FACTOR_KEY' | 'JWT_ACCESS_SECRET' | 'TWO_FACTOR_KEY_PREVIOUS'>): string[] {
  const current = env.TWO_FACTOR_KEY ?? env.JWT_ACCESS_SECRET ?? '';
  return [current, ...env.TWO_FACTOR_KEY_PREVIOUS.filter((k) => k !== current)];
}
