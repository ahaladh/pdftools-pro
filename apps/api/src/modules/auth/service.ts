import type { Request } from 'express';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type { PlanId, SessionInfo, TwoFactorChallenge, UserView } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { SessionModel, UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import { newId } from '../../utils/security.js';
import type { Mailer } from '../mail/mailer.js';
import type { AuditService } from './audit.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { planInfo } from '../teams/plan.js';
import { newOpaqueToken, sha256, signAccessToken, signMfaChallenge, verifyMfaChallenge } from './tokens.js';
import { hashRecovery, looksLikeRecovery, newRecoveryCodes, newTotpSecret, openSecret, otpauthUri, sealSecret, base32Encode, verifyTotp } from './totp.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserDoc = any;
const MAX_FAILED = 5, LOCK_MS = 15 * 60_000, RESET_TTL_MS = 60 * 60_000, RESEND_COOLDOWN_MS = 60_000, PENDING_2FA_MS = 15 * 60_000;

/** Second-factor state. An account is protected by an authenticator app, by security keys, or by both; recovery codes back either. */
export const hasTotp = (u: UserDoc) => !!u.twoFactor?.enabledAt;
export const hasKeys = (u: UserDoc) => (u.securityKeys?.length ?? 0) > 0;
export const secondFactorOn = (u: UserDoc) => hasTotp(u) || hasKeys(u);

export interface Session { user: UserView; accessToken: string; expiresIn: number; refresh: { token: string; expires: Date } }

export function userView(u: UserDoc, extra?: { effectivePlan: PlanId; team?: { id: string; name: string; role: import('@pdftools/shared').TeamRole; plan: PlanId } }): UserView {
  const b = u.billing;
  return {
    id: String(u._id), email: u.email, name: u.name ?? '', role: u.role, plan: u.plan as PlanId, createdAt: new Date(u.createdAt).toISOString(),
    emailVerified: !!u.emailVerifiedAt, twoFactorEnabled: secondFactorOn(u), totpEnabled: hasTotp(u), securityKeys: u.securityKeys?.length ?? 0,
    effectivePlan: extra?.effectivePlan ?? (u.plan as PlanId), ...(extra?.team ? { team: extra.team } : {}),
    ...(b?.subscriptionId ? { subscription: { status: b.status, plan: b.plan, currentPeriodEnd: b.currentPeriodEnd?.toISOString(), cancelAtPeriodEnd: b.cancelAtPeriodEnd } } : {}),
  };
}

export class AuthService {
  constructor(private env: Env, private mailer: Mailer, private audit: AuditService, private log: Logger,
    private hooks: { deleteUserData: (owner: string) => Promise<void>; cancelSubscription: (u: UserDoc) => Promise<void>; leaveTeam: (u: UserDoc) => Promise<void> }) {}

  private async issue(user: UserDoc, req: Request, family = newId(12), since = new Date()): Promise<Session> {
    const token = newOpaqueToken();
    const expires = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
    await SessionModel.create({ userId: user._id, tokenHash: sha256(token), family, since, expiresAt: expires, userAgent: String(req.get('user-agent') ?? '').slice(0, 300) });
    const accessToken = await signAccessToken(this.env.JWT_ACCESS_SECRET, String(user._id), user.role, this.env.ACCESS_TOKEN_TTL_MINUTES);
    return { user: userView(user, await planInfo(user)), accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_MINUTES * 60, refresh: { token, expires } };
  }

  async register(req: Request, d: { email: string; password: string; name: string }): Promise<Session> {
    if (await UserModel.exists({ email: d.email })) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    const user = await UserModel.create({ email: d.email, name: d.name, passwordHash: await hashPassword(d.password), lastLoginAt: new Date() });
    await this.audit.record(`u:${user._id}`, 'auth.register', { req });
    await this.sendVerification(user);
    return this.issue(user, req);
  }

  async login(req: Request, email: string, password: string): Promise<Session | TwoFactorChallenge> {
    const user = await UserModel.findOne({ email });
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new HttpError(429, 'account_locked', 'Too many failed attempts. Try again in a few minutes.');
    }
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await burnPasswordCheck(password), false);
    if (!user || !ok) {
      if (user) {
        user.failedLogins += 1;
        if (user.failedLogins >= MAX_FAILED) { user.lockedUntil = new Date(Date.now() + LOCK_MS); user.failedLogins = 0; }
        await user.save();
      }
      await this.audit.record(user ? `u:${user._id}` : 'anonymous', 'auth.login_failed', { req });
      throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
    }
    if (user.status !== 'active') throw new HttpError(403, 'account_disabled', 'This account has been disabled.');
    if (secondFactorOn(user)) {
      // Password is right, but no session is issued until the second factor is too. Failed-login counting is NOT reset yet.
      await this.audit.record(`u:${user._id}`, 'auth.login_password_ok_2fa_pending', { req });
      return { twoFactorRequired: true, challenge: await signMfaChallenge(this.env.JWT_ACCESS_SECRET, String(user._id)), methods: { totp: hasTotp(user), securityKey: hasKeys(user) } };
    }
    user.failedLogins = 0; user.lockedUntil = undefined; user.lastLoginAt = new Date();
    await user.save();
    await this.audit.record(`u:${user._id}`, 'auth.login', { req });
    return this.issue(user, req);
  }

  // ------------------------------------------------------------------ two-factor
  private key() { return this.env.TWO_FACTOR_KEY ?? this.env.JWT_ACCESS_SECRET; }

  /** Refuse while the account is locked (too many wrong passwords or second factors). */
  assertNotLocked(user: UserDoc) {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw new HttpError(429, 'account_locked', 'Too many failed attempts. Try again in a few minutes.');
  }

  /** A wrong second factor of any kind counts toward the same lockout as a wrong password. */
  async recordSecondFactorFailure(user: UserDoc, req: Request, what: string) {
    const failed = (user.twoFactor?.failed ?? 0) + 1;
    const lock = failed >= MAX_FAILED;
    await UserModel.updateOne({ _id: user._id }, lock ? { $set: { 'twoFactor.failed': 0, lockedUntil: new Date(Date.now() + LOCK_MS) } } : { $set: { 'twoFactor.failed': failed } });
    await this.audit.record(`u:${user._id}`, 'auth.2fa_failed', { req, meta: { what } });
  }

  /**
   * Check a TOTP or recovery code for a user with a second factor on. Wrong codes count toward the same lockout as wrong
   * passwords, a TOTP step cannot be reused, and a recovery code is consumed atomically (two parallel requests cannot both use it).
   */
  async checkSecondFactor(user: UserDoc, code: string, req: Request): Promise<void> {
    this.assertNotLocked(user);
    let ok = false;
    if (looksLikeRecovery(code)) {
      const r = await UserModel.updateOne({ _id: user._id, 'twoFactor.recoveryHashes': hashRecovery(code) }, { $pull: { 'twoFactor.recoveryHashes': hashRecovery(code) } });
      ok = r.modifiedCount === 1;
      if (ok) await this.audit.record(`u:${user._id}`, 'auth.recovery_code_used', { req });
    } else if (hasTotp(user)) {
      const step = verifyTotp(openSecret(this.key(), user.twoFactor.secretEnc), code, Date.now(), { lastStep: user.twoFactor.lastStep });
      if (step !== null) {
        const r = await UserModel.updateOne({ _id: user._id, $or: [{ 'twoFactor.lastStep': { $lt: step } }, { 'twoFactor.lastStep': { $exists: false } }] }, { $set: { 'twoFactor.lastStep': step } });
        ok = r.modifiedCount === 1;
      }
    }
    if (ok) { await UserModel.updateOne({ _id: user._id }, { $set: { 'twoFactor.failed': 0 } }); return; }
    await this.recordSecondFactorFailure(user, req, 'code');
    throw new HttpError(401, 'invalid_code', hasTotp(user) ? 'That code is not valid. Check your authenticator app, or use a recovery code.' : 'That is not a valid recovery code.');
  }

  /** The account a sign-in challenge (issued after a correct password) belongs to, or an error telling the user to start over. */
  async pendingUser(challenge: string): Promise<UserDoc> {
    const id = await verifyMfaChallenge(this.env.JWT_ACCESS_SECRET, challenge);
    const user = id ? await UserModel.findById(id).catch(() => null) : null;
    if (!user || user.status !== 'active' || !secondFactorOn(user)) throw new HttpError(401, 'invalid_challenge', 'This sign-in has expired. Please start again.');
    return user;
  }

  /** The second factor has been proven: clear the lockout counters and open the session. */
  async finishLogin(req: Request, user: UserDoc, via: string): Promise<Session> {
    const fresh = await UserModel.findById(user._id);
    fresh.failedLogins = 0; fresh.lockedUntil = undefined; fresh.lastLoginAt = new Date();
    await fresh.save();
    await this.audit.record(`u:${user._id}`, 'auth.login', { req, meta: { twoFactor: true, via } });
    return this.issue(fresh, req);
  }

  async completeTwoFactorLogin(req: Request, challenge: string, code: string): Promise<Session> {
    const user = await this.pendingUser(challenge);
    await this.checkSecondFactor(user, code, req);
    return this.finishLogin(req, user, looksLikeRecovery(code) ? 'recovery' : 'totp');
  }

  /** Revoke every session (used when the set of second factors changes) and open a fresh one for this device. */
  async rotateSessions(req: Request, user: UserDoc): Promise<Session> {
    await SessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    return this.issue(user, req);
  }

  async requirePassword(user: UserDoc, password: string) {
    if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(403, 'invalid_credentials', 'Password is incorrect.');
  }

  /** Step 1: generate a secret and show it once. Nothing is enforced until the user proves their app works (step 2). */
  async beginTwoFactor(user: UserDoc, password: string) {
    await this.requirePassword(user, password);
    if (hasTotp(user)) throw new HttpError(409, 'two_factor_enabled', 'An authenticator app is already set up.');
    const secret = newTotpSecret();
    user.twoFactorPending = { secretEnc: sealSecret(this.key(), secret), createdAt: new Date() };
    await user.save();
    const uri = otpauthUri({ issuer: this.env.BRAND_NAME, account: user.email, secret });
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret: base32Encode(secret), otpauthUri: uri, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
  }

  /** Step 2: a valid code from the app turns it on and returns the recovery codes (the only time they are shown). */
  async enableTwoFactor(req: Request, user: UserDoc, code: string): Promise<{ recoveryCodes: string[]; session: Session }> {
    const p = user.twoFactorPending;
    if (!p?.secretEnc || Date.now() - new Date(p.createdAt).getTime() > PENDING_2FA_MS) throw new HttpError(400, 'no_pending_setup', 'Start the setup again.');
    const step = verifyTotp(openSecret(this.key(), p.secretEnc), code, Date.now());
    if (step === null) throw new HttpError(400, 'invalid_code', 'That code is not valid. Check your authenticator app and try again.');
    const codes = newRecoveryCodes();
    user.twoFactor = { secretEnc: p.secretEnc, enabledAt: new Date(), lastStep: step, recoveryHashes: codes.map(hashRecovery), failed: 0 };
    user.twoFactorPending = undefined;
    await user.save();
    // Anyone who had a session before this point may not hold the second factor: sign every other device out.
    await SessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await this.audit.record(`u:${user._id}`, 'auth.2fa_enabled', { req });
    return { recoveryCodes: codes, session: await this.issue(user, req) };
  }

  /** Turns off the authenticator app. If security keys remain the account stays protected by them; otherwise two-step sign-in is off. */
  async disableTwoFactor(req: Request, user: UserDoc, password: string, code: string): Promise<Session> {
    await this.requirePassword(user, password);
    if (!hasTotp(user)) throw new HttpError(409, 'two_factor_off', 'No authenticator app is set up.');
    await this.checkSecondFactor(user, code, req);
    const fresh = await UserModel.findById(user._id);
    fresh.twoFactor = hasKeys(fresh) ? { recoveryHashes: fresh.twoFactor.recoveryHashes ?? [], failed: 0 } : undefined;
    fresh.twoFactorPending = undefined;
    await fresh.save();
    await this.audit.record(`u:${user._id}`, 'auth.2fa_disabled', { req });
    return this.rotateSessions(req, fresh);
  }

  async regenerateRecoveryCodes(req: Request, user: UserDoc, password: string, code: string): Promise<string[]> {
    await this.requirePassword(user, password);
    if (!secondFactorOn(user)) throw new HttpError(409, 'two_factor_off', 'Two-factor sign-in is not on.');
    await this.checkSecondFactor(user, code, req);
    const codes = newRecoveryCodes();
    await UserModel.updateOne({ _id: user._id }, { $set: { 'twoFactor.recoveryHashes': codes.map(hashRecovery) } });
    await this.audit.record(`u:${user._id}`, 'auth.recovery_codes_regenerated', { req });
    return codes;
  }

  /** Support path for someone who lost both their phone and their recovery codes. The admin action is audited. */
  async adminResetTwoFactor(req: Request, target: UserDoc) {
    target.twoFactor = undefined; target.twoFactorPending = undefined; target.securityKeys = []; target.webauthnChallenge = undefined;
    await target.save();
    await SessionModel.updateMany({ userId: target._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await this.audit.record(`u:${target._id}`, 'auth.2fa_reset_by_admin', { req, meta: { by: String(req.user?._id) } });
  }

  // ------------------------------------------------------------------ email verification
  async sendVerification(user: UserDoc) {
    const token = newOpaqueToken();
    user.verifyTokenHash = sha256(token);
    user.verifyTokenExpires = new Date(Date.now() + this.env.VERIFY_TOKEN_TTL_HOURS * 3600_000);
    user.verifySentAt = new Date();
    await user.save();
    const link = `${this.env.PUBLIC_URL.replace(/\/$/, '')}/verify-email?token=${token}`;
    try {
      await this.mailer.send({ to: user.email, subject: `Confirm your email for ${this.env.BRAND_NAME}`, text: `Confirm that this is your email address by opening this link within ${this.env.VERIFY_TOKEN_TTL_HOURS} hours:\n\n${link}\n\nIf you did not create an account, ignore this email.` });
    } catch (e) { this.log.error({ err: e }, 'could not send verification email'); }
  }

  async verifyEmail(req: Request, token: string) {
    // Single use: the hash is cleared by the same atomic update that sets the timestamp.
    const user = await UserModel.findOneAndUpdate(
      { verifyTokenHash: sha256(token), verifyTokenExpires: { $gt: new Date() } },
      { $set: { emailVerifiedAt: new Date() }, $unset: { verifyTokenHash: 1, verifyTokenExpires: 1 } },
    );
    if (!user) throw new HttpError(400, 'invalid_token', 'This confirmation link is invalid or has expired. Request a new one from your account page.');
    await this.audit.record(`u:${user._id}`, 'auth.email_verified', { req });
  }

  async resendVerification(req: Request, user: UserDoc) {
    if (user.emailVerifiedAt) throw new HttpError(409, 'already_verified', 'Your email is already confirmed.');
    const wait = user.verifySentAt ? RESEND_COOLDOWN_MS - (Date.now() - new Date(user.verifySentAt).getTime()) : 0;
    if (wait > 0) throw new HttpError(429, 'too_soon', `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another email.`);
    await this.sendVerification(user);
    await this.audit.record(`u:${user._id}`, 'auth.verification_resent', { req });
  }

  // ------------------------------------------------------------------ devices / sessions
  async listSessions(userId: unknown, currentToken: string | undefined): Promise<SessionInfo[]> {
    const current = currentToken ? (await SessionModel.findOne({ tokenHash: sha256(currentToken) }))?.family : undefined;
    const rows = await SessionModel.find({ userId, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ updatedAt: -1 });
    return rows.map((s) => ({ id: s.family, device: describeDevice(s.userAgent), since: new Date(s.since ?? s.createdAt).toISOString(), lastUsed: new Date(s.updatedAt).toISOString(), current: s.family === current }));
  }
  async revokeSession(req: Request, userId: unknown, family: string) {
    const r = await SessionModel.updateMany({ userId, family, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    if (!r.modifiedCount) throw new HttpError(404, 'not_found', 'That session no longer exists.');
    await this.audit.record(`u:${userId}`, 'auth.session_revoked', { req });
  }
  async revokeOtherSessions(req: Request, userId: unknown, currentToken: string | undefined) {
    const current = currentToken ? (await SessionModel.findOne({ tokenHash: sha256(currentToken), userId }))?.family : undefined;
    if (!current) throw new HttpError(400, 'no_current_session', 'Sign in again, then retry.');
    const r = await SessionModel.updateMany({ userId, family: { $ne: current }, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await this.audit.record(`u:${userId}`, 'auth.other_sessions_revoked', { req });
    return r.modifiedCount;
  }

  /** Rotate the refresh token. Presenting an already-used token revokes the whole family (theft signal). */
  async refresh(req: Request, token: string): Promise<Session> {
    const s = await SessionModel.findOne({ tokenHash: sha256(token) });
    if (!s) throw new HttpError(401, 'invalid_session', 'Please sign in again.');
    if (s.revokedAt) {
      await SessionModel.updateMany({ family: s.family }, { revokedAt: new Date() });
      await this.audit.record(`u:${s.userId}`, 'auth.refresh_reuse_detected', { req });
      throw new HttpError(401, 'invalid_session', 'Please sign in again.');
    }
    if (s.expiresAt.getTime() < Date.now()) throw new HttpError(401, 'invalid_session', 'Please sign in again.');
    const user = await UserModel.findById(s.userId);
    if (!user || user.status !== 'active') throw new HttpError(401, 'invalid_session', 'Please sign in again.');
    // Atomic claim so two parallel refreshes cannot both succeed.
    const claimed = await SessionModel.findOneAndUpdate({ _id: s._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    if (!claimed) throw new HttpError(401, 'invalid_session', 'Please sign in again.');
    return this.issue(user, req, s.family, s.since ?? s.createdAt);
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const s = await SessionModel.findOne({ tokenHash: sha256(token) });
    if (s) await SessionModel.updateMany({ family: s.family }, { revokedAt: new Date() });
  }

  async forgotPassword(req: Request, email: string) {
    const user = await UserModel.findOne({ email });
    if (!user || user.status !== 'active') return; // identical response either way: no account enumeration
    const token = newOpaqueToken();
    user.resetTokenHash = sha256(token); user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
    await user.save();
    await this.audit.record(`u:${user._id}`, 'auth.reset_requested', { req });
    const link = `${this.env.PUBLIC_URL.replace(/\/$/, '')}/reset-password?token=${token}`;
    try {
      await this.mailer.send({ to: user.email, subject: 'Reset your password', text: `Use this link within 1 hour to choose a new password:\n\n${link}\n\nIf you did not request this, ignore this email.` });
    } catch (e) { this.log.error({ err: e }, 'could not send password reset email'); }
  }

  async resetPassword(req: Request, token: string, password: string) {
    const user = await UserModel.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } });
    if (!user) throw new HttpError(400, 'invalid_token', 'This reset link is invalid or has expired.');
    user.passwordHash = await hashPassword(password);
    user.resetTokenHash = undefined; user.resetTokenExpires = undefined; user.failedLogins = 0; user.lockedUntil = undefined;
    user.emailVerifiedAt ??= new Date(); // the reset link went to this inbox, which proves the same thing
    await user.save();
    await SessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await this.audit.record(`u:${user._id}`, 'auth.password_reset', { req });
  }

  async changePassword(req: Request, user: UserDoc, current: string, next: string): Promise<Session> {
    if (!(await verifyPassword(current, user.passwordHash))) throw new HttpError(403, 'invalid_credentials', 'Current password is incorrect.');
    user.passwordHash = await hashPassword(next);
    await user.save();
    await SessionModel.updateMany({ userId: user._id, revokedAt: { $exists: false } }, { revokedAt: new Date() });
    await this.audit.record(`u:${user._id}`, 'auth.password_changed', { req });
    return this.issue(user, req);
  }

  async deleteAccount(req: Request, user: UserDoc, password: string) {
    if (!(await verifyPassword(password, user.passwordHash))) throw new HttpError(403, 'invalid_credentials', 'Password is incorrect.');
    await this.hooks.leaveTeam(user); // may refuse: an owner of a team with other members must hand it over first
    await this.hooks.cancelSubscription(user).catch((e) => this.log.error({ err: e }, 'subscription cancel failed during account deletion'));
    await this.hooks.deleteUserData(`u:${user._id}`);
    await SessionModel.deleteMany({ userId: user._id });
    await UserModel.deleteOne({ _id: user._id });
    await this.audit.record(`u:${user._id}`, 'account.deleted', { req });
  }

  /** Create the first admin from env if that email does not exist yet. */
  async seedAdmin() {
    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw } = this.env;
    if (!email || !pw || (await UserModel.exists({ email: email.toLowerCase() }))) return;
    await UserModel.create({ email: email.toLowerCase(), name: 'Administrator', role: 'admin', plan: 'business', passwordHash: await hashPassword(pw), emailVerifiedAt: new Date() });
    this.log.warn({ email }, 'bootstrap admin created; remove ADMIN_PASSWORD from the environment');
  }
}

/** Friendly "Chrome on Linux" from a user-agent string, without a parsing library; unknown agents say so. */
export function describeDevice(ua: string | undefined): string {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /curl|node|undici|supertest|python/i.test(s) ? 'API client' : 'Unknown browser';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux|X11/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
