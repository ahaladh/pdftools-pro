import { z } from 'zod';

export const PLAN_IDS = ['guest', 'free', 'pro', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const PAID_PLANS = ['pro', 'business'] as const;

/** Entitlements and pricing for one plan. Stored in settings; never hardcoded at call sites. */
export const planConfigSchema = z.object({
  id: z.enum(PLAN_IDS),
  name: z.string().min(1).max(40),
  maxFileMB: z.number().min(1).max(5000),
  maxPages: z.number().int().min(1).max(100000),
  maxFiles: z.number().int().min(1).max(500),
  dailyOps: z.number().int().min(0).max(1_000_000),
  maxConcurrentJobs: z.number().int().min(1).max(100),
  retentionMinutes: z.number().int().min(1).max(60 * 24 * 30),
  /** Higher runs first when the queue is busy. */
  priority: z.number().int().min(0).max(100),
  /** Tools this plan may NOT use (premium tools). */
  blockedTools: z.array(z.string().max(40)).max(100),
  /** Price in the smallest currency unit per month. 0 = not purchasable. */
  priceCents: z.number().int().min(0).max(10_000_000),
  currency: z.string().length(3),
  stripePriceId: z.string().max(100).optional(),
  features: z.array(z.string().max(120)).max(20),
});
export type PlanConfig = z.infer<typeof planConfigSchema>;

export const appSettingsSchema = z.object({
  maintenance: z.boolean(),
  /** Tools switched off for everyone. */
  disabledTools: z.array(z.string().max(40)).max(100),
  plans: z.object({ guest: planConfigSchema, free: planConfigSchema, pro: planConfigSchema, business: planConfigSchema }),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export type Role = 'user' | 'admin';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  plan: PlanId;
  subscription?: { status: string; plan: PlanId; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean };
  createdAt: string;
  /** The user has proven control of the email address. */
  emailVerified: boolean;
  twoFactorEnabled: boolean;
}

/** Result of a password check for an account with two-factor sign-in on: no session yet, just a short-lived challenge. */
export interface TwoFactorChallenge { twoFactorRequired: true; challenge: string }

export interface SessionInfo { id: string; device: string; since: string; lastUsed: string; current: boolean }

export interface UsageView {
  plan: PlanId;
  today: { ops: number; limit: number };
  limits: { maxFileMB: number; maxPages: number; maxFiles: number; maxConcurrentJobs: number; retentionMinutes: number };
  last30Days: { day: string; ops: number }[];
}

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
  name: z.string().trim().max(80).default(''),
});
export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(128) });
export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
export const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(10, 'Use at least 10 characters').max(128) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10, 'Use at least 10 characters').max(128) });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
/** A 6-digit authenticator code, or a recovery code (xxxxx-xxxxx; spaces/case/hyphen are forgiven). */
const secondFactor = z.string().trim().min(6).max(16);
export const twoFactorLoginSchema = z.object({ challenge: z.string().min(20).max(2000), code: secondFactor });
export const reauthSchema = z.object({ password: z.string().min(1).max(128) });
export const twoFactorEnableSchema = z.object({ code: secondFactor });
export const twoFactorConfirmSchema = z.object({ password: z.string().min(1).max(128), code: secondFactor });
export const profileSchema = z.object({ name: z.string().trim().max(80) });
