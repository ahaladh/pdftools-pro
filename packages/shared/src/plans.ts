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
  /** Any second factor is on: an authenticator app, a security key, or both. */
  twoFactorEnabled: boolean;
  /** An authenticator app (TOTP) is set up. */
  totpEnabled: boolean;
  /** Number of registered security keys. */
  securityKeys: number;
  /** The plan that actually applies: the better of `plan` (their own) and their team's. */
  effectivePlan: PlanId;
  team?: { id: string; name: string; role: TeamRole; plan: PlanId };
}

export type TeamRole = 'owner' | 'admin' | 'member';
export interface TeamMemberView { userId: string; email: string; name: string; role: TeamRole; joinedAt: string; you: boolean }
export interface TeamInviteView { id: string; email: string; role: 'admin' | 'member'; invitedAt: string; expiresAt: string }
export interface TeamView {
  id: string; name: string; myRole: TeamRole;
  /** The plan the team pays for (free when there is no active subscription). */
  plan: PlanId;
  /** Seats the plan allows, and how many are taken by members plus pending invitations. */
  seats: number; seatsUsed: number;
  members: TeamMemberView[];
  /** Pending invitations: owners and admins only. */
  invites: TeamInviteView[];
  /** Billing state: owner only. */
  subscription?: { status: string; plan: PlanId; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean };
  createdAt: string;
}

/** Result of a password check for an account with two-factor sign-in on: no session yet, just a short-lived challenge. */
export interface TwoFactorChallenge { twoFactorRequired: true; challenge: string; /** Which second factors this account can use now (recovery codes always work). */ methods: { totp: boolean; securityKey: boolean } }

/** A registered security key / passkey used as a second factor. The id is the (public) credential id. */
export interface SecurityKeyView { id: string; name: string; createdAt: string; lastUsedAt?: string; /** multiDevice = a synced passkey rather than a key that never leaves the device. */ deviceType: 'singleDevice' | 'multiDevice'; backedUp: boolean }

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
/** A WebAuthn credential as produced by the browser (validated in depth by the verifier; this only bounds its shape and size). */
const webauthnResponse = z.object({
  id: z.string().min(1).max(1400), rawId: z.string().min(1).max(1400), type: z.literal('public-key'),
  response: z.record(z.unknown()), clientExtensionResults: z.record(z.unknown()).optional(), authenticatorAttachment: z.string().max(40).optional(),
}).passthrough();
export const securityKeyRegisterSchema = z.object({ response: webauthnResponse, name: z.string().trim().min(1, 'Give the key a name').max(40) });
export const securityKeyLoginOptionsSchema = z.object({ challenge: z.string().min(20).max(2000) });
export const securityKeyLoginSchema = z.object({ challenge: z.string().min(20).max(2000), response: webauthnResponse });
export const createTeamSchema = z.object({ name: z.string().trim().min(2, 'Use at least 2 characters').max(60) });
export const renameTeamSchema = createTeamSchema;
export const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'member']).default('member') });
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200) });
export const memberRoleSchema = z.object({ role: z.enum(['admin', 'member']) });
export const transferSchema = z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/) });
export const profileSchema = z.object({ name: z.string().trim().max(80) });
