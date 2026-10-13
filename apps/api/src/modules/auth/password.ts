import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// OWASP-recommended scrypt parameters (N=2^15, r=8, p=1). Pure Node, no native addon to maintain.
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64, MAXMEM = 128 * 1024 * 1024;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) => scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM } as ScryptOptions, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Verify against a throwaway hash so "no such user" costs the same as "wrong password". */
export async function burnPasswordCheck(password: string) {
  dummy ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummy);
}
