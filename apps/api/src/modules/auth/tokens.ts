import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISS = 'pdftools', AUD = 'pdftools-api';
const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(secret: string, userId: string, role: string, ttlMinutes: number) {
  return new SignJWT({ role }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ISS).setAudience(AUD)
    .setIssuedAt().setExpirationTime(`${ttlMinutes}m`).sign(key(secret));
}

/** Returns the user id, or null if the token is invalid/expired. */
export async function verifyAccessToken(secret: string, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: ISS, audience: AUD, algorithms: ['HS256'] });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch { return null; }
}

export const newOpaqueToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// A password-checked-but-not-yet-second-factor-checked login. Its own audience means it can never be used as an access token.
const MFA_AUD = 'pdftools-mfa';
export async function signMfaChallenge(secret: string, userId: string, ttlSeconds = 300) {
  return new SignJWT({ purpose: 'mfa' }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ISS).setAudience(MFA_AUD)
    .setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(key(secret));
}
export async function verifyMfaChallenge(secret: string, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: ISS, audience: MFA_AUD, algorithms: ['HS256'] });
    return payload.purpose === 'mfa' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch { return null; }
}
