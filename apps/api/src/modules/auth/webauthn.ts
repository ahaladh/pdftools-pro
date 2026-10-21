import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { SecurityKeyView } from '@pdftools/shared';
import type { Env } from '../../config/env.js';
import { UserModel } from '../../db/models.js';
import { HttpError } from '../../utils/errors.js';
import type { AuditService } from './audit.js';
import { webauthnConfig } from './webauthn-config.js';
import { hasKeys, hasTotp, secondFactorOn, type AuthService, type Session, type UserDoc } from './service.js';
import { newRecoveryCodes, hashRecovery } from './totp.js';

export const MAX_KEYS = 10;
const CHALLENGE_MS = 5 * 60_000;

export { webauthnConfig } from './webauthn-config.js';

export const keyView = (k: { credentialId: string; name: string; createdAt: Date; lastUsedAt?: Date; deviceType?: string; backedUp?: boolean }): SecurityKeyView => ({
  id: k.credentialId, name: k.name, createdAt: new Date(k.createdAt).toISOString(), ...(k.lastUsedAt ? { lastUsedAt: new Date(k.lastUsedAt).toISOString() } : {}),
  deviceType: k.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice', backedUp: !!k.backedUp,
});

/**
 * Security keys (WebAuthn) as a second factor. A key never replaces the password: it is checked after it, exactly where
 * an authenticator code would be. We store only the public key and a signature counter.
 */
export class SecurityKeyService {
  private cfg: ReturnType<typeof webauthnConfig>;
  constructor(env: Env, private auth: AuthService, private audit: AuditService) {
    // An invalid PUBLIC_URL must not stop the whole API from starting (doctor reports it); keys just are not available.
    try { this.cfg = webauthnConfig(env); } catch { this.cfg = { rpID: '', rpName: env.BRAND_NAME, origins: [] }; }
  }
  private ready() { if (!this.cfg.rpID) throw new HttpError(503, 'not_configured', 'Security keys are not available: the site address is not configured correctly.'); }

  list(user: UserDoc): SecurityKeyView[] { return (user.securityKeys ?? []).map(keyView); }

  // ---------------------------------------------------------------- challenges
  private async storeChallenge(userId: unknown, kind: 'register' | 'login', value: string) {
    await UserModel.updateOne({ _id: userId }, { $set: { webauthnChallenge: { value, kind, expiresAt: new Date(Date.now() + CHALLENGE_MS) } } });
  }

  /** Take the outstanding challenge. Atomic, so a response can be used once: a replayed or raced response finds nothing. */
  private async takeChallenge(userId: unknown, kind: 'register' | 'login'): Promise<string | null> {
    const old = await UserModel.findOneAndUpdate(
      { _id: userId, 'webauthnChallenge.kind': kind, 'webauthnChallenge.expiresAt': { $gt: new Date() } },
      { $unset: { webauthnChallenge: 1 } }, { new: false },
    );
    return old?.webauthnChallenge?.value ?? null;
  }

  // ---------------------------------------------------------------- registration (signed in, password re-entered)
  async registrationOptions(user: UserDoc, password: string) {
    this.ready();
    await this.auth.requirePassword(user, password);
    if ((user.securityKeys?.length ?? 0) >= MAX_KEYS) throw new HttpError(409, 'too_many_keys', `You can register up to ${MAX_KEYS} security keys. Remove one first.`);
    const opts = await generateRegistrationOptions({
      rpName: this.cfg.rpName, rpID: this.cfg.rpID, userName: user.email, userDisplayName: user.name || user.email,
      // A stable, non-identifying handle (not the database id, not the email).
      userID: createHash('sha256').update(`pdftools-webauthn:${user._id}`).digest(),
      attestationType: 'none',
      excludeCredentials: (user.securityKeys ?? []).map((k: { credentialId: string; transports?: string[] }) => ({ id: k.credentialId, transports: k.transports })),
      // A second factor: no discoverable credential needed; ask for user verification only if the key can do it cheaply.
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
    });
    await this.storeChallenge(user._id, 'register', opts.challenge);
    return opts;
  }

  async register(req: Request, user: UserDoc, response: RegistrationResponseJSON, name: string): Promise<{ keys: SecurityKeyView[]; recoveryCodes?: string[]; session?: Session }> {
    this.ready();
    const expected = await this.takeChallenge(user._id, 'register');
    if (!expected) throw new HttpError(400, 'no_pending_setup', 'This request has expired. Start adding the key again.');
    let info;
    try {
      const v = await verifyRegistrationResponse({ response, expectedChallenge: expected, expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpID, requireUserVerification: false });
      if (!v.verified) throw new Error('not verified');
      info = v.registrationInfo;
    } catch (e) {
      await this.audit.record(`u:${user._id}`, 'auth.security_key_add_failed', { req, meta: { reason: (e as Error).message.slice(0, 120) } });
      throw new HttpError(400, 'invalid_key', 'That security key could not be verified. Try again, or use a different key.');
    }
    const fresh = await UserModel.findById(user._id);
    const wasOff = !secondFactorOn(fresh);
    const needCodes = !(fresh.twoFactor?.recoveryHashes?.length > 0);
    const codes = needCodes ? newRecoveryCodes() : undefined;
    const entry = {
      credentialId: info.credential.id, publicKey: Buffer.from(info.credential.publicKey), counter: info.credential.counter, transports: info.credential.transports ?? [],
      name, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, createdAt: new Date(),
    };
    try {
      const r = await UserModel.updateOne(
        { _id: user._id, [`securityKeys.${MAX_KEYS - 1}`]: { $exists: false } },
        { $push: { securityKeys: entry }, ...(codes ? { $set: { 'twoFactor.recoveryHashes': codes.map(hashRecovery) } } : {}) },
      );
      if (r.modifiedCount !== 1) throw new HttpError(409, 'too_many_keys', `You can register up to ${MAX_KEYS} security keys. Remove one first.`);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new HttpError(409, 'key_in_use', 'That security key is already registered to an account.');
      throw e;
    }
    await this.audit.record(`u:${user._id}`, 'auth.security_key_added', { req, meta: { deviceType: entry.deviceType } });
    const after = await UserModel.findById(user._id);
    // First second factor on the account: anyone holding an older session may not hold it, so sign them out (as for an authenticator app).
    const session = wasOff ? await this.auth.rotateSessions(req, after) : undefined;
    return { keys: this.list(after), ...(codes ? { recoveryCodes: codes } : {}), ...(session ? { session } : {}) };
  }

  // ---------------------------------------------------------------- sign-in (after the password)
  async loginOptions(challenge: string) {
    this.ready();
    const user = await this.auth.pendingUser(challenge);
    if (!hasKeys(user)) throw new HttpError(409, 'no_security_key', 'This account has no security key. Use your authenticator app or a recovery code.');
    this.auth.assertNotLocked(user);
    const opts = await generateAuthenticationOptions({
      rpID: this.cfg.rpID, userVerification: 'discouraged', // the password was the first factor; possession of the key is the second
      allowCredentials: user.securityKeys.map((k: { credentialId: string; transports?: string[] }) => ({ id: k.credentialId, transports: k.transports })),
    });
    await this.storeChallenge(user._id, 'login', opts.challenge);
    return opts;
  }

  async login(req: Request, challenge: string, response: AuthenticationResponseJSON): Promise<Session> {
    this.ready();
    const user = await this.auth.pendingUser(challenge);
    this.auth.assertNotLocked(user);
    const expected = await this.takeChallenge(user._id, 'login');
    if (!expected) throw new HttpError(401, 'invalid_challenge', 'This sign-in has expired. Please start again.');
    const key = (user.securityKeys ?? []).find((k: { credentialId: string }) => k.credentialId === response.id);
    const fail = async (why: string): Promise<never> => {
      await this.auth.recordSecondFactorFailure(user, req, `security_key:${why}`);
      throw new HttpError(401, 'invalid_key', 'That security key was not accepted. Try again, or use a recovery code.');
    };
    if (!key) return fail('unknown_credential');
    let newCounter: number;
    try {
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge: expected, expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpID, requireUserVerification: false,
        credential: { id: key.credentialId, publicKey: new Uint8Array(key.publicKey), counter: key.counter ?? 0, transports: key.transports },
      });
      if (!v.verified) return fail('not_verified');
      newCounter = v.authenticationInfo.newCounter;
    } catch (e) { return fail((e as Error).message.slice(0, 80)); }
    // Store the new counter only if nobody else moved it meanwhile (the library already rejected a counter that went backwards).
    const r = await UserModel.updateOne(
      { _id: user._id, securityKeys: { $elemMatch: { credentialId: key.credentialId, counter: key.counter ?? 0 } } },
      { $set: { 'securityKeys.$.counter': newCounter, 'securityKeys.$.lastUsedAt': new Date() } },
    );
    if (r.modifiedCount !== 1) return fail('counter_race');
    await UserModel.updateOne({ _id: user._id }, { $set: { 'twoFactor.failed': 0 } });
    return this.auth.finishLogin(req, user, 'security_key');
  }

  // ---------------------------------------------------------------- removal (signed in, password and a second factor)
  async remove(req: Request, user: UserDoc, id: string, password: string, code: string): Promise<{ keys: SecurityKeyView[]; session: Session }> {
    await this.auth.requirePassword(user, password);
    if (!(user.securityKeys ?? []).some((k: { credentialId: string }) => k.credentialId === id)) throw new HttpError(404, 'not_found', 'That security key was not found.');
    this.auth.assertMayDropFactor(user, { totp: hasTotp(user), keys: (user.securityKeys?.length ?? 1) - 1 });
    await this.auth.checkSecondFactor(user, code, req);
    const r = await UserModel.updateOne({ _id: user._id }, { $pull: { securityKeys: { credentialId: id } } });
    if (r.modifiedCount !== 1) throw new HttpError(404, 'not_found', 'That security key was not found.');
    const fresh = await UserModel.findById(user._id);
    // Nothing left that needs recovery codes: two-step sign-in is now off, so do not keep valid codes lying around.
    if (!secondFactorOn(fresh)) { fresh.twoFactor = undefined; await fresh.save(); }
    await this.audit.record(`u:${user._id}`, 'auth.security_key_removed', { req, meta: { stillProtected: secondFactorOn(fresh), totp: hasTotp(fresh) } });
    const session = await this.auth.rotateSessions(req, fresh);
    return { keys: this.list(fresh), session };
  }
}
