import { describe, it, expect } from 'vitest';
import { base32Decode, base32Encode, hashRecovery, hotp, looksLikeRecovery, newRecoveryCodes, normaliseRecovery, openSecret, otpauthUri, sealSecret, totpAt, verifyTotp } from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890'); // the shared test secret in RFC 6238 appendix B (SHA-1)

describe('TOTP matches the RFC', () => {
  // RFC 6238 appendix B, 8-digit SHA-1 vectors
  const vectors: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of vectors) it(`T=${t}s -> ${code}`, () => expect(totpAt(RFC_SECRET, t * 1000, 8)).toBe(code));
  it('6-digit codes are the last six digits of the same value', () => expect(totpAt(RFC_SECRET, 59_000)).toBe('287082'));
  it('HOTP matches RFC 4226 appendix D (counter 0..9)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, i) => hotp(RFC_SECRET, i))).toEqual(expected);
  });
});

describe('verification window and replay', () => {
  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30_000);
  it('accepts the current step and one step either side, nothing further', () => {
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + d), now)).toBe(step + d);
    for (const d of [-2, 2, 10]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + d), now)).toBeNull();
  });
  it('rejects a code whose step was already used (replay), but accepts a later one', () => {
    const code = hotp(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, { lastStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, { lastStep: step - 1 })).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, { lastStep: step })).toBe(step + 1);
  });
  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345', '１２３４５６', ' 123456']) expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
  });
  it('a different secret never validates', () => {
    expect(verifyTotp(Buffer.from('another secret!!!!!!'), hotp(RFC_SECRET, step), now)).toBeNull();
  });
});

describe('base32', () => {
  it('RFC 4648 vectors and round trips', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar'); // tolerant of spacing/case a user might type
    for (let n = 0; n < 40; n++) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)); expect(base32Decode(base32Encode(b)).equals(b)).toBe(true); }
    expect(() => base32Decode('not valid!')).toThrow();
  });
  it('builds a standard otpauth URI', () => {
    const u = new URL(otpauthUri({ issuer: 'PDF Tools', account: 'a+b@example.com', secret: RFC_SECRET }));
    expect(u.protocol).toBe('otpauth:'); expect(u.host).toBe('totp');
    expect(decodeURIComponent(u.pathname)).toBe('/PDF Tools:a+b@example.com');
    expect(u.searchParams.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(u.searchParams.get('issuer')).toBe('PDF Tools'); expect(u.searchParams.get('digits')).toBe('6'); expect(u.searchParams.get('period')).toBe('30');
  });
});

describe('secrets at rest', () => {
  const key = 'k'.repeat(40);
  it('round-trips, never stores plaintext, and uses a fresh IV each time', () => {
    const a = sealSecret(key, RFC_SECRET), b = sealSecret(key, RFC_SECRET);
    expect(a).not.toBe(b);
    expect(openSecret(key, a).equals(RFC_SECRET)).toBe(true);
    expect(a).not.toContain(base32Encode(RFC_SECRET));
    expect(Buffer.from(a.split('.')[3]!, 'base64url').includes(RFC_SECRET)).toBe(false);
  });
  it('detects tampering, truncation, the wrong key and unknown formats', () => {
    const s = sealSecret(key, RFC_SECRET).split('.');
    const flip = (i: number) => { const x = [...s]; const buf = Buffer.from(x[i]!, 'base64url'); buf[0] = buf[0]! ^ 1; x[i] = buf.toString('base64url'); return x.join('.'); };
    for (const i of [1, 2, 3]) expect(() => openSecret(key, flip(i))).toThrow();
    expect(() => openSecret('x'.repeat(40), s.join('.'))).toThrow();
    expect(() => openSecret(key, s.slice(0, 3).join('.'))).toThrow();
    expect(() => openSecret(key, ['v2', ...s.slice(1)].join('.'))).toThrow();
  });
});

describe('recovery codes', () => {
  it('are unique, well formed, normalised for comparison and hashed', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) { expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/); expect(c).not.toMatch(/[ilo01]/); expect(looksLikeRecovery(c)).toBe(true); }
    const c = codes[0]!;
    expect(hashRecovery(c.toUpperCase())).toBe(hashRecovery(c));
    expect(hashRecovery(` ${c.replace('-', ' ')} `)).toBe(hashRecovery(c));
    expect(hashRecovery(c)).not.toContain(c);
    expect(normaliseRecovery(' AB cde-FGHIJ ')).toBe('abcde-fghij');
    expect(looksLikeRecovery('123456')).toBe(false);
  });
});
