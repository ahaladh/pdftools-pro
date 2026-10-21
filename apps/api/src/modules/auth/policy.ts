import type { Env } from '../../config/env.js';

/** Whether administrators must have a second sign-in step. Explicit setting wins; otherwise on exactly in production. */
export const adminTwoFactorRequired = (env: Pick<Env, 'REQUIRE_ADMIN_2FA' | 'NODE_ENV'>): boolean => env.REQUIRE_ADMIN_2FA ?? env.NODE_ENV === 'production';
