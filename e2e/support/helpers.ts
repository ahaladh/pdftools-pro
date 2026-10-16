import { expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { readState } from './stack';

/** A PDF whose pages have a recognisable size and text, so tests can tell which input a page came from. */
export async function makePdf(pages: number, opts: { w?: number; h?: number; label?: string } = {}): Promise<Buffer> {
  const { w = 300, h = 400, label = 'Doc' } = opts;
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([w, h]).drawText(`${label} page ${i + 1}`, { x: 30, y: h - 80, size: 22, font });
  return Buffer.from(await d.save());
}
export const file = (name: string, buffer: Buffer, mimeType = 'application/pdf') => ({ name, mimeType, buffer });

/** Collect problems a user would never see but a security/quality review cares about. */
export function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${e.violatedDirective} ${e.blockedURI}`];
    });
  });
  return {
    problems,
    async cspViolations() { return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []); },
  };
}

export async function register(page: Page, email: string, password: string, name = 'E2E User') {
  await page.goto('/register');
  await page.getByLabel('Name (optional)').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account$/);
}
export async function login(page: Page, email: string, password: string, next?: string) {
  await page.goto(next ? `/signin?next=${encodeURIComponent(next)}` : '/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The most recent password-reset link the (dev) mailer wrote to the API log. */
export function lastResetLink(): string {
  const log = readFileSync(readState().apiLog, 'utf8');
  const links = [...log.matchAll(/reset-password\?token=([\w-]+)/g)];
  if (!links.length) throw new Error('no reset link in API log');
  return `/reset-password?token=${links[links.length - 1]![1]}`;
}

export const uniqueEmail = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.com`;

/** The most recent link of a given kind (e.g. 'verify-email') that the (dev) mailer wrote to the API log. */
export function lastEmailLink(kind: 'verify-email' | 'reset-password'): string {
  const log = readFileSync(readState().apiLog, 'utf8');
  const links = [...log.matchAll(new RegExp(`${kind}\\?token=([\\w-]+)`, 'g'))];
  if (!links.length) throw new Error(`no ${kind} link in API log`);
  return `/${kind}?token=${links[links.length - 1]![1]}`;
}

/**
 * An authenticator app, in 15 lines, written independently of the server's implementation (RFC 6238, HMAC-SHA1, 6 digits).
 * `steps` shifts the time by whole 30 s periods, so a test can ask for the NEXT code instead of waiting for it.
 */
export function authenticatorCode(base32Key: string, steps = 0, nowMs = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32Key.replace(/[\s=-]/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000) + steps));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
