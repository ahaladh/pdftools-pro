import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import mongoose from 'mongoose';
import { file, makePdf, register, uniqueEmail, watchConsole } from '../support/helpers';
import { readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
const PER_MEMBER = 2; // Pro allowance during this spec, so a team of two shares 4
test.describe.configure({ mode: 'serial' });

const adminSettings = async (change: (s: { plans: Record<string, { dailyOps: number }> }) => void) => {
  const st = readState();
  const call = async (path: string, init: RequestInit = {}, token?: string) => (await (await fetch(`${st.apiUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } })).json()) as { data: never };
  const { data: sess } = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: st.adminEmail, password: st.adminPassword }) }) as { data: { accessToken: string } };
  const { data: settings } = await call('/api/admin/settings', {}, sess.accessToken) as { data: { plans: Record<string, { dailyOps: number }> } };
  const before = settings.plans.pro!.dailyOps;
  change(settings);
  await call('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings) }, sess.accessToken);
  return before;
};
let originalProOps = 1000;
test.beforeAll(async () => { originalProOps = await adminSettings((s) => { s.plans.pro!.dailyOps = PER_MEMBER; }); });
test.afterAll(async () => { await adminSettings((s) => { s.plans.pro!.dailyOps = originalProOps; }); }); // never leave the shared stack changed

const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const person = async (browser: Browser, prefix: string) => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const email = uniqueEmail(prefix);
  await register(page, email, PW);
  return { ctx, page, email };
};
const db = async <T>(fn: (c: mongoose.Connection) => Promise<T>) => {
  const conn = await mongoose.createConnection(readState().env.MONGODB_URI!).asPromise();
  try { return await fn(conn); } finally { await conn.close(); }
};
const rotateOnce = async (page: Page) => {
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file('a.pdf', await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
};

/** Two people in a paid team (Stripe is not part of this stack, as in the teams spec: plan and membership are set directly). */
async function paidTeam(browser: Browser) {
  const owner = await person(browser, 'pool-owner');
  await owner.page.goto('/account');
  await owner.page.getByLabel('What should the team be called?').fill('Acme Design');
  await owner.page.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Acme Design' })).toBeVisible();
  const colleague = await person(browser, 'pool-colleague');
  await db(async (c) => {
    const o = await c.collection('users').findOne({ email: owner.email });
    const m = await c.collection('users').findOne({ email: colleague.email });
    const team = await c.collection('teams').findOne({ ownerId: o!._id });
    await c.collection('teams').updateOne({ _id: team!._id }, { $set: { plan: 'pro' } });
    await c.collection('teammembers').insertOne({ teamId: team!._id, userId: m!._id, role: 'member', createdAt: new Date(), updatedAt: new Date() });
  });
  return { owner, colleague };
}

test('a paid team shares one allowance: one person can use the whole pool, and then everyone is stopped, with the numbers shown', async ({ browser }) => {
  test.setTimeout(150_000);
  const { owner, colleague } = await paidTeam(browser);
  const mon = watchConsole(owner.page);

  // the colleague alone uses the whole shared allowance (2 each x 2 people = 4): twice what Pro gives one person
  for (let i = 0; i < 2 * PER_MEMBER; i++) {
    await rotateOnce(colleague.page);
    await expect(colleague.page.getByRole('heading', { name: 'Your file is ready' }), `operation ${i + 1}`).toBeVisible({ timeout: 30_000 });
  }

  // (a finished job is recorded a moment after it shows as ready: wait until the pool says so before the next request)
  await colleague.page.goto('/account');
  await expect(colleague.page.getByText('4 / 4').first()).toBeVisible({ timeout: 15_000 });

  // now even the owner, who has used nothing, is stopped, and is told why in terms of the team
  await rotateOnce(owner.page);
  await expect(owner.page.getByRole('alert')).toContainText(/Acme Design.*shared allowance of 4 operations \(2 for each of its 2 members\)/);
  await expect(owner.page.getByRole('heading', { name: 'Your file is ready' })).toHaveCount(0);

  // the account page shows what gates them: the pool, and their own share of it
  await owner.page.goto('/account');
  await expect(owner.page.getByText('Team operations today')).toBeVisible();
  await expect(owner.page.getByText('4 / 4').first()).toBeVisible();
  await expect(owner.page.getByText('Shared with your team “Acme Design” (2 members)')).toBeVisible();
  await expect(owner.page.getByText(/You have used 0 of it today/)).toBeVisible();
  await colleague.page.goto('/account');
  await expect(colleague.page.getByText(/You have used 4 of it today/)).toBeVisible();

  // the team card: the pool bar, and the owner (not the colleague) sees who used what
  const pool = owner.page.getByLabel('Shared allowance', { exact: true });
  await expect(pool).toContainText('Shared allowance today');
  await expect(pool).toContainText('4 / 4');
  await expect(owner.page.getByLabel(`Operations used today by ${colleague.email}`)).toHaveText('4 today');
  await expect(owner.page.getByLabel(`Operations used today by ${owner.email}`)).toHaveText('0 today');
  await colleague.page.reload();
  await expect(colleague.page.getByLabel('Shared allowance', { exact: true })).toContainText('4 / 4');
  await expect(colleague.page.getByLabel(`Operations used today by ${owner.email}`)).toHaveCount(0);
  await axe(owner.page, 'pooled team card');

  // the team plan ends: pooling stops at once and the owner is back on their own (untouched) allowance
  await db(async (c) => { await c.collection('teams').updateMany({ name: 'Acme Design', plan: 'pro' }, { $set: { plan: 'free' } }); });
  await rotateOnce(owner.page);
  await expect(owner.page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 30_000 });

  expect(mon.problems.filter((p) => !/status of 429/.test(p))).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
  await owner.ctx.close(); await colleague.ctx.close();
});

test('an owner can limit what one person draws from the pool; the limit is explained to them and the others are unaffected', async ({ browser }) => {
  test.setTimeout(120_000);
  const { owner, colleague } = await paidTeam(browser);
  await owner.page.goto('/account');
  const pool = owner.page.getByLabel('Shared allowance', { exact: true });
  await expect(pool).toBeVisible();
  // an invalid value cannot be saved
  await pool.getByLabel('Daily limit per person').fill('0');
  await expect(pool.getByRole('button', { name: 'Save limit' })).toBeDisabled();
  await pool.getByLabel('Daily limit per person').fill('1');
  await pool.getByRole('button', { name: 'Save limit' }).click();
  await expect(pool.getByText('Currently 1.')).toBeVisible();
  await axe(owner.page, 'pool limit control');

  // the colleague gets one operation and is then told it is their limit, not the team's
  await rotateOnce(colleague.page);
  await expect(colleague.page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 30_000 });
  await colleague.page.goto('/account');
  await expect(colleague.page.getByText(/Your team limits each person to 1 a day/)).toBeVisible({ timeout: 15_000 });
  await expect(colleague.page.getByText('1 / 4').first()).toBeVisible();
  await rotateOnce(colleague.page);
  await expect(colleague.page.getByRole('alert')).toContainText(/Acme Design.*limits each person to 1 operations a day/);
  // the team card shows members the limit as text, with no control
  await colleague.page.goto('/account');
  await expect(colleague.page.getByLabel('Shared allowance', { exact: true })).toContainText('Your team limits each person to 1 operations a day.');
  await expect(colleague.page.getByLabel('Daily limit per person')).toHaveCount(0);

  // the owner, who has used nothing, is not affected; and removing the limit lets the colleague carry on
  await rotateOnce(owner.page);
  await expect(owner.page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 30_000 });
  await owner.page.goto('/account');
  await owner.page.getByLabel('Shared allowance', { exact: true }).getByRole('button', { name: 'Remove limit' }).click();
  await expect(owner.page.getByLabel('Shared allowance', { exact: true }).getByText('Optional. Without one')).toBeVisible();
  await rotateOnce(colleague.page);
  await expect(colleague.page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 30_000 });
  await owner.ctx.close(); await colleague.ctx.close();
});
