import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sha256 } from './tokens.js';

// ---------------------------------------------------------------- base32 (RFC 4648, no padding)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- HOTP / TOTP (RFC 4226 / 6238), HMAC-SHA1
export const TOTP_STEP = 30, TOTP_DIGITS = 6;

export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 10 ** digits).padStart(digits, '0');
}
export const totpAt = (secret: Uint8Array, nowMs: number, digits = TOTP_DIGITS, step = TOTP_STEP) => hotp(secret, Math.floor(nowMs / 1000 / step), digits);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Check a code against the current step and `window` steps either side (clock drift). Returns the matched step, or null.
 * `lastStep` rejects any step at or before the last accepted one, so a code cannot be used twice (replay).
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, opts: { window?: number; lastStep?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const window = opts.window ?? 1;
  const cur = Math.floor(nowMs / 1000 / TOTP_STEP);
  let hit: number | null = null;
  for (let d = -window; d <= window; d++) { // no early exit: constant work whatever the input
    const step = cur + d;
    if (same(hotp(secret, step), code) && step > (opts.lastStep ?? -1) && hit === null) hit = step;
  }
  return hit;
}

export const newTotpSecret = () => randomBytes(20); // 160 bits, as RFC 4226 recommends

export function otpauthUri(opts: { issuer: string; account: string; secret: Uint8Array }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(opts.secret)}&issuer=${encodeURIComponent(opts.issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

// ---------------------------------------------------------------- secrets at rest (AES-256-GCM)
const keyFrom = (ikm: string) => Buffer.from(hkdfSync('sha256', ikm, 'pdftools', 'two-factor-secret-v1', 32));
/** A short, non-reversible name for a key, stored beside what it sealed so operators can tell which key is in use. */
export const keyId = (ikm: string): string => createHmac('sha256', keyFrom(ikm)).update('pdftools-key-id').digest().subarray(0, 6).toString('base64url');

/** None of the configured keys opens this value (the wrong key, a key that was dropped too early, or tampering). */
export class SecretKeyError extends Error { constructor(message = 'no configured key opens this secret') { super(message); this.name = 'SecretKeyError'; } }

/**
 * `v2.<keyId>.<iv>.<tag>.<ciphertext>` (base64url, AES-256-GCM): a fresh random IV per message; the tag makes tampering
 * detectable and the key id is authenticated with the message. Values written by earlier versions, `v1.<iv>.<tag>.<ct>`
 * (no key id), still open.
 */
export function sealSecret(ikm: string, plain: Uint8Array): string {
  const iv = randomBytes(12);
  const kid = keyId(ikm);
  const c = createCipheriv('aes-256-gcm', keyFrom(ikm), iv);
  c.setAAD(Buffer.from(`v2.${kid}`));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ['v2', kid, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export interface Opened { plain: Buffer; /** Index into the keys offered: 0 is the current key. */ keyIndex: number; format: 'v1' | 'v2' }
/** Open with the first key that works. Returns null when none does; throws only for text that is not a sealed secret at all. */
export function tryOpenSecret(keys: readonly string[], sealed: string): Opened | null {
  const parts = sealed.split('.');
  const v = parts[0];
  if (v === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, ct] = parts as [string, string, string, string, string];
    for (const [i, ikm] of keys.entries()) {
      if (keyId(ikm) !== kid) continue;
      try {
        const d = createDecipheriv('aes-256-gcm', keyFrom(ikm), Buffer.from(iv, 'base64url'));
        d.setAAD(Buffer.from(`v2.${kid}`)); d.setAuthTag(Buffer.from(tag, 'base64url'));
        return { plain: Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]), keyIndex: i, format: 'v2' };
      } catch { /* wrong key or tampered */ }
    }
    return null;
  }
  if (v === 'v1' && parts.length === 4) {
    const [, iv, tag, ct] = parts as [string, string, string, string];
    for (const [i, ikm] of keys.entries()) {
      try {
        const d = createDecipheriv('aes-256-gcm', keyFrom(ikm), Buffer.from(iv, 'base64url'));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return { plain: Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]), keyIndex: i, format: 'v1' };
      } catch { /* try the next key */ }
    }
    return null;
  }
  throw new Error('unrecognised secret format');
}
/** Open with the current key, or any of the previous ones while a rotation is in progress. */
export function openSecret(keys: string | readonly string[], sealed: string): Buffer {
  const r = tryOpenSecret(typeof keys === 'string' ? [keys] : keys, sealed);
  if (!r) throw new SecretKeyError();
  return r.plain;
}

// ---------------------------------------------------------------- recovery codes
const RC_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i l o 0 1)
export const RECOVERY_COUNT = 10;
const rcPart = () => Array.from({ length: 5 }, () => RC_CHARS[randomInt(RC_CHARS.length)]).join('');
/** 10 codes of ~49 bits each. They are random and long, so a plain SHA-256 is enough to store them. */
export const newRecoveryCodes = () => Array.from({ length: RECOVERY_COUNT }, () => `${rcPart()}-${rcPart()}`);
/** Canonical form `xxxxx-xxxxx`: users type these with a space, without the hyphen, in capitals... all of which must match. */
export const normaliseRecovery = (s: string) => { const t = s.toLowerCase().replace(/[\s-]/g, ''); return t.length === 10 ? `${t.slice(0, 5)}-${t.slice(5)}` : t; };
export const hashRecovery = (code: string) => sha256(normaliseRecovery(code));
export const looksLikeRecovery = (s: string) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(normaliseRecovery(s));
