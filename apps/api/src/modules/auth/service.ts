import type { Request } from 'express';
import type { Logger } from 'pino';
import type { PlanId, UserView } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { SessionModel, UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import { newId } from '../../utils/security.js';
import type { Mailer } from '../mail/mailer.js';
import type { AuditService } from './audit.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { newOpaqueToken, sha256, signAccessToken } from './tokens.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserDoc = any;
const MAX_FAILED = 5, LOCK_MS = 15 * 60_000, RESET_TTL_MS = 60 * 60_000;

export interface Session { user: UserView; accessToken: string; expiresIn: number; refresh: { token: string; expires: Date } }

export function userView(u: UserDoc): UserView {
  const b = u.billing;
  return {
    id: String(u._id), email: u.email, name: u.name ?? '', role: u.role, plan: u.plan as PlanId, createdAt: new Date(u.createdAt).toISOString(),
    ...(b?.subscriptionId ? { subscription: { status: b.status, plan: b.plan, currentPeriodEnd: b.currentPeriodEnd?.toISOString(), cancelAtPeriodEnd: b.cancelAtPeriodEnd } } : {}),
  };
}

export class AuthService {
  constructor(private env: Env, private mailer: Mailer, private audit: AuditService, private log: Logger,
    private hooks: { deleteUserData: (owner: string) => Promise<void>; cancelSubscription: (u: UserDoc) => Promise<void> }) {}

  private async issue(user: UserDoc, req: Request, family = newId(12)): Promise<Session> {
    const token = newOpaqueToken();
    const expires = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
    await SessionModel.create({ userId: user._id, tokenHash: sha256(token), family, expiresAt: expires, userAgent: String(req.get('user-agent') ?? '').slice(0, 300) });
    const accessToken = await signAccessToken(this.env.JWT_ACCESS_SECRET, String(user._id), user.role, this.env.ACCESS_TOKEN_TTL_MINUTES);
    return { user: userView(user), accessToken, expiresIn: this.env.ACCESS_TOKEN_TTL_MINUTES * 60, refresh: { token, expires } };
  }

  async register(req: Request, d: { email: string; password: string; name: string }): Promise<Session> {
    if (await UserModel.exists({ email: d.email })) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
    const user = await UserModel.create({ email: d.email, name: d.name, passwordHash: await hashPassword(d.password), lastLoginAt: new Date() });
    await this.audit.record(`u:${user._id}`, 'auth.register', { req });
    return this.issue(user, req);
  }

  async login(req: Request, email: string, password: string): Promise<Session> {
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
    user.failedLogins = 0; user.lockedUntil = undefined; user.lastLoginAt = new Date();
    await user.save();
    await this.audit.record(`u:${user._id}`, 'auth.login', { req });
    return this.issue(user, req);
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
    return this.issue(user, req, s.family);
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
    await UserModel.create({ email: email.toLowerCase(), name: 'Administrator', role: 'admin', plan: 'business', passwordHash: await hashPassword(pw) });
    this.log.warn({ email }, 'bootstrap admin created; remove ADMIN_PASSWORD from the environment');
  }
}
