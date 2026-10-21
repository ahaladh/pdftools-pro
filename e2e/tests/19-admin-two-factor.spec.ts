import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { authenticatorCode, register, uniqueEmail, watchConsole } from '../support/helpers';
import { API_PORT, ROOT, WEB_PORT, readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
// A second API and web server with the policy switched ON, on the same database. The main stack keeps it off (as in development)
// so the other specs, which sign in as the seeded administrator without a second step, are unaffected.
const API2 = API_PORT + 10, WEB2 = WEB_PORT + 10;
const web2 = `http://localhost:${WEB2}`, api2 = `http://localhost:${API2}`;
test.use({ baseURL: web2 });

const kids: ChildProcess[] = [];
const up = async (url: string) => { for (let i = 0; i < 240; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`${url} did not come up`); };
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const s = readState();
  mkdirSync(join(ROOT, 'e2e/.logs'), { recursive: true });
  const out = createWriteStream(join(ROOT, 'e2e/.logs/policy-stack.log'));
  const start = (cmd: string, args: string[], env: Record<string, string>, cwd: string) => {
    const p = spawn(cmd, args, { cwd, env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout?.pipe(out); p.stderr?.pipe(out); kids.push(p);
  };
  start(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], { ...s.env, PORT: String(API2), CORS_ORIGINS: web2, PUBLIC_URL: web2, QUEUE_DRIVER: 'inline', REQUIRE_ADMIN_2FA: 'true' }, join(ROOT, 'apps/api'));
  await up(`${api2}/health`);
  start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB2), '--strictPort', '--host', 'localhost'], { API_URL: api2 }, join(ROOT, 'apps/web'));
  await up(`${web2}/`);
});
test.afterAll(() => { for (const p of kids) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } } });

/** Make `email` an administrator through the main stack (where the seeded administrator can still act without a second step). */
async function promote(email: string) {
  const s = readState();
  const post = async (path: string, init: RequestInit, token?: string) => {
    const r = await fetch(`${s.apiUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return (await r.json()) as { data: never };
  };
  const { data: sess } = await post('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: s.adminEmail, password: s.adminPassword }) }) as { data: { accessToken: string } };
  const { data: list } = await post(`/api/admin/users?q=${encodeURIComponent(email)}`, { method: 'GET' }, sess.accessToken) as { data: { rows: { id: string; email: string }[] } };
  const id = list.rows.find((u) => u.email === email)!.id;
  await post(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }, sess.accessToken);
}

test('an administrator is held out of the admin area until they enrol, can still reach their account, and cannot switch the protection off', async ({ page, request }) => {
  const mon = watchConsole(page);
  const email = uniqueEmail('policy-admin');
  await register(page, email, PW);
  await promote(email);
  await page.reload();

  // the account page explains what is needed
  const notice = page.getByRole('alert').filter({ hasText: 'required for administrators' });
  await expect(notice).toBeVisible();
  await axe(page, 'admin notice');

  // the server really refuses (not just the screen): sign in over the API and ask for the admin area
  const login = await request.post(`${api2}/api/auth/login`, { data: { email, password: PW } });
  const token = (await login.json()).data.accessToken as string;
  const denied = await request.get(`${api2}/api/admin/dashboard`, { headers: { authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
  expect((await denied.json()).error.code).toBe('two_factor_required');

  // the Admin page says what to do, with a way there
  await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('Turn on two-step sign-in to use the admin area');
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await axe(page, 'admin blocked');
  await page.getByRole('link', { name: 'your account page' }).click();
  await expect(page).toHaveURL(/\/account$/);

  // enrol an authenticator app
  await page.getByRole('button', { name: 'Set up' }).click();
  await page.getByLabel('Your password, to set up the authenticator app').fill(PW);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const key = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill(authenticatorCode(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const list = page.getByRole('list', { name: 'Your recovery codes' });
  await expect(list).toBeVisible();
  const recovery = (await list.getByRole('listitem').allInnerTexts()).map((s) => s.trim());
  await page.getByRole('button', { name: 'I have saved them' }).click();
  await expect(notice).toHaveCount(0);

  // now the admin area opens and its data loads
  await page.goto('/admin');
  await expect(page.getByRole('tablist', { name: 'Admin sections' })).toBeVisible();
  await expect(page.getByText('Registered users')).toBeVisible();

  // the only factor cannot be turned off, and the page says why
  await page.goto('/account');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PW);
  await page.getByLabel('Authenticator or recovery code').fill(recovery[0]!);
  await page.getByRole('button', { name: 'Turn off' }).last().click();
  await expect(page.getByRole('alert').filter({ hasText: 'must keep two-step sign-in on' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off' }).first()).toBeVisible(); // still on

  expect(mon.problems.filter((p) => !/status of (403|409)/.test(p))).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});
