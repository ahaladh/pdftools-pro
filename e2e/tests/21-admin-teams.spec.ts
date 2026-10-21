import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import mongoose from 'mongoose';
import { login, register, uniqueEmail, watchConsole } from '../support/helpers';
import { readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const db = async <T>(fn: (c: mongoose.Connection) => Promise<T>) => {
  const conn = await mongoose.createConnection(readState().env.MONGODB_URI!).asPromise();
  try { return await fn(conn); } finally { await conn.close(); }
};
const person = async (browser: Browser, prefix: string) => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const email = uniqueEmail(prefix);
  await register(page, email, PW);
  return { ctx, page, email };
};

test('support finds a team, hands it to a member because the owner cannot be reached, and deletes another; the people see the effect', async ({ browser }) => {
  test.setTimeout(120_000);
  const teamName = `Support ${Date.now().toString(36)}`;
  const owner = await person(browser, 'tm-owner');
  const heir = await person(browser, 'tm-heir');
  await owner.page.goto('/account');
  await owner.page.getByLabel('What should the team be called?').fill(teamName);
  await owner.page.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.page.getByRole('heading', { name: teamName })).toBeVisible();
  // Stripe and invitations are covered elsewhere: put the heir in the team, confirmed, and give the team a paid plan
  await db(async (c) => {
    const o = await c.collection('users').findOne({ email: owner.email });
    const h = await c.collection('users').findOne({ email: heir.email });
    await c.collection('users').updateOne({ _id: h!._id }, { $set: { emailVerifiedAt: new Date() } });
    const t = await c.collection('teams').findOne({ ownerId: o!._id });
    await c.collection('teams').updateOne({ _id: t!._id }, { $set: { plan: 'pro' } });
    await c.collection('teammembers').insertOne({ teamId: t!._id, userId: h!._id, role: 'member', createdAt: new Date(), updatedAt: new Date() });
  });

  // an administrator signs in and finds the team by name
  const admin = await browser.newContext(); const ap = await admin.newPage();
  const mon = watchConsole(ap);
  const st = readState();
  await login(ap, st.adminEmail, st.adminPassword, '/admin');
  await expect(ap.getByRole('heading', { name: 'Administration' })).toBeVisible();
  await expect(ap.getByText('Teams', { exact: true }).first()).toBeVisible(); // the overview counts them
  await ap.getByRole('tab', { name: 'Teams' }).click();
  await ap.getByLabel('Search teams by name or owner email').fill(teamName);
  await ap.getByRole('button', { name: 'Search' }).click();
  const row = ap.getByRole('row').filter({ hasText: teamName });
  await expect(row).toContainText(owner.email);
  await expect(row).toContainText('pro');
  await expect(row).toContainText('2 / 3');
  await axe(ap, 'admin teams list');

  // open it: members, with confirmation state; the owner has no "Make owner" button, the unconfirmed would be disabled
  await ap.getByRole('button', { name: `Open team ${teamName}` }).click();
  const detail = ap.getByRole('region', { name: 'Team details' });
  await expect(detail).toBeVisible();
  const members = detail.getByRole('table', { name: 'Team members' });
  await expect(members.getByRole('row').filter({ hasText: owner.email })).toContainText('owner');
  await expect(members.getByRole('button', { name: `Make ${owner.email} the owner` })).toHaveCount(0);
  await expect(detail).not.toContainText('cus_'); // no payment-provider ids in the console
  await axe(ap, 'admin team detail');

  // the owner is unreachable: hand the team to the heir (a confirmation shows who stays on as admin)
  ap.once('dialog', (d) => { expect(d.message()).toContain(heir.email); expect(d.message()).toContain(owner.email); void d.accept(); });
  await detail.getByRole('button', { name: `Make ${heir.email} the owner` }).click();
  await expect(members.getByRole('row').filter({ hasText: heir.email })).toContainText('owner');
  await expect(members.getByRole('row').filter({ hasText: owner.email })).toContainText('admin');

  // the people see it: the heir is now the owner (and manages billing/seats), the old owner is an admin
  await heir.page.goto('/account');
  await expect(heir.page.getByText('You are the owner')).toBeVisible();
  await owner.page.goto('/account');
  await expect(owner.page.getByText('You are an admin')).toBeVisible();

  // the audit log records who did it
  await ap.getByRole('tab', { name: 'Audit log' }).click();
  await expect(ap.getByRole('tabpanel')).toContainText('admin.team_ownership_transferred');

  // and an abandoned team can be deleted: the members keep their accounts but lose the team
  await ap.getByRole('tab', { name: 'Teams' }).click();
  await ap.getByLabel('Search teams by name or owner email').fill(teamName);
  await ap.getByRole('button', { name: 'Search' }).click();
  await ap.getByRole('button', { name: `Open team ${teamName}` }).click();
  ap.once('dialog', (d) => { expect(d.message()).toContain('cannot be undone'); void d.accept(); });
  await ap.getByRole('region', { name: 'Team details' }).getByRole('button', { name: 'Delete team' }).click();
  await expect(ap.getByRole('region', { name: 'Team details' })).toHaveCount(0);
  await expect(ap.getByRole('row').filter({ hasText: teamName })).toHaveCount(0);
  await heir.page.goto('/account');
  await expect(heir.page.getByLabel('What should the team be called?')).toBeVisible(); // no team any more
  await expect(heir.page.getByText(heir.email)).toBeVisible(); // still signed in, account intact

  expect(mon.problems).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
  await owner.ctx.close(); await heir.ctx.close(); await admin.close();
});
