import { expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
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
