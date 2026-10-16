import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import mongoose from 'mongoose';
import { lastEmailLink, login, register, uniqueEmail } from '../support/helpers';
import { readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
test.describe.configure({ mode: 'serial' });

/** Stripe is not part of the e2e stack, so a team's paid plan is set in the database here. The webhook path is covered by the API tests. */
async function setTeamPlan(owner: string, plan: 'free' | 'pro' | 'business') {
  const conn = await mongoose.createConnection(readState().env.MONGODB_URI!).asPromise();
  try {
    const user = await conn.collection('users').findOne({ email: owner });
    await conn.collection('teams').updateOne({ ownerId: user!._id }, { $set: { plan } });
  } finally { await conn.close(); }
}
const confirmEmail = async (page: Page) => { await page.goto(lastEmailLink('verify-email')); await expect(page.getByText('your email address is confirmed')).toBeVisible(); };
const person = async (browser: Browser, prefix: string) => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const email = uniqueEmail(prefix);
  await register(page, email, PW);
  await confirmEmail(page);
  return { ctx, page, email };
};
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const members = (page: Page) => page.getByRole('list', { name: 'Team members' }).getByRole('listitem');

test('create a team, invite a colleague who joins through the emailed link, and share the team plan', async ({ browser }) => {
  const owner = await person(browser, 'owner');
  await owner.page.goto('/account');
  await expect(owner.page.getByLabel('Team', { exact: true })).toContainText('Create a team to share one plan');
  await owner.page.getByLabel('What should the team be called?').fill('Acme Design');
  await owner.page.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Acme Design' })).toBeVisible();
  await expect(owner.page.getByLabel('Seats')).toHaveText('1 of 1 seat used');
  await expect(owner.page.getByText('This team is on the free plan')).toBeVisible();
  await expect(owner.page.getByRole('button', { name: 'Send invitation' })).toBeDisabled(); // no room until the team pays

  await setTeamPlan(owner.email, 'pro');
  await owner.page.reload();
  await expect(owner.page.getByLabel('Seats')).toHaveText('1 of 3 seats used');

  const colleague = await person(browser, 'colleague');
  await owner.page.getByLabel('Invite by email').fill(colleague.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('list', { name: 'Pending invitations' })).toContainText(colleague.email);
  await expect(owner.page.getByLabel('Seats')).toHaveText('2 of 3 seats used');
  const link = lastEmailLink('team/join');

  // someone who is not signed in is sent to sign in and brought back to the same invitation
  const anon = await browser.newContext(); const ap = await anon.newPage();
  await ap.goto(link);
  await expect(ap).toHaveURL(/\/signin\?next=.*team%2Fjoin.*token/);
  await anon.close();

  // the wrong account is told so, without learning the invited address
  const stranger = await person(browser, 'stranger');
  await stranger.page.goto(link);
  await stranger.page.getByRole('button', { name: 'Join team' }).click();
  await expect(stranger.page.getByRole('alert')).toContainText('different email address');
  await expect(stranger.page.getByRole('alert')).not.toContainText(colleague.email);
  await stranger.ctx.close();

  // the invited person joins
  await colleague.page.goto(link);
  await colleague.page.getByRole('button', { name: 'Join team' }).click();
  await expect(colleague.page).toHaveURL(/\/account$/);
  await expect(colleague.page.getByRole('heading', { name: 'Acme Design' })).toBeVisible();
  await expect(colleague.page.getByText('(shared by the team “Acme Design”)')).toBeVisible();
  await expect(members(colleague.page)).toHaveCount(2);
  // members see no invitation or billing controls
  await expect(colleague.page.getByLabel('Invite by email')).toHaveCount(0);
  await expect(colleague.page.getByText('Team billing')).toHaveCount(0);
  await axe(colleague.page, 'team (member view)');

  // the link works once
  await colleague.page.goto(link);
  await colleague.page.getByRole('button', { name: 'Join team' }).click();
  await expect(colleague.page.getByRole('alert')).toContainText(/already in a team|invalid, expired or was already used/);

  // owner: promote, then remove, and the colleague loses the shared plan immediately
  await owner.page.reload();
  await expect(members(owner.page)).toHaveCount(2);
  await expect(owner.page.getByRole('list', { name: 'Pending invitations' })).toHaveCount(0);
  await owner.page.getByLabel(`Role of ${colleague.email}`).selectOption('admin');
  await expect(owner.page.getByLabel(`Role of ${colleague.email}`)).toHaveValue('admin');
  await axe(owner.page, 'team (owner view)');
  owner.page.once('dialog', (d) => { void d.accept(); });
  await owner.page.getByRole('button', { name: `Remove ${colleague.email} from the team` }).click();
  await expect(members(owner.page)).toHaveCount(1);
  await colleague.page.goto('/account');
  await expect(colleague.page.getByText('(shared by the team')).toHaveCount(0);
  await expect(colleague.page.getByLabel('Team', { exact: true })).toContainText('Create a team to share one plan');
  await owner.ctx.close(); await colleague.ctx.close();
});

test('a member can leave; an owner cannot walk away from a team that has other people in it', async ({ browser }) => {
  const owner = await person(browser, 'owner2');
  await owner.page.goto('/account');
  await owner.page.getByLabel('What should the team be called?').fill('Leavers Inc');
  await owner.page.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.page.getByLabel('Seats')).toBeVisible();
  await expect(owner.page.getByRole('button', { name: 'Leave team' })).toHaveCount(0); // owners do not get a Leave button
  await setTeamPlan(owner.email, 'pro');

  const m = await person(browser, 'leaver');
  await owner.page.reload();
  await owner.page.getByLabel('Invite by email').fill(m.email);
  await owner.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.page.getByRole('list', { name: 'Pending invitations' })).toBeVisible();
  await m.page.goto(lastEmailLink('team/join'));
  await m.page.getByRole('button', { name: 'Join team' }).click();
  await expect(m.page.getByRole('heading', { name: 'Leavers Inc' })).toBeVisible();

  // the owner cannot delete their account while others are in the team
  await owner.page.reload();
  await owner.page.getByLabel('Confirm with your password').fill(PW);
  await owner.page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(owner.page.getByRole('alert').filter({ hasText: 'Transfer ownership' })).toBeVisible();

  // hand the team over, then the member (now owner) is in charge
  await owner.page.getByLabel('Transfer ownership to').selectOption({ label: m.email });
  owner.page.once('dialog', (d) => { void d.accept(); });
  await owner.page.getByRole('button', { name: 'Transfer' }).click();
  await expect(owner.page.getByText('You are an admin')).toBeVisible();
  await m.page.reload();
  await expect(m.page.getByText('You are the owner')).toBeVisible();
  await expect(m.page.getByText('Team billing')).toBeVisible();

  // the former owner (now an admin) leaves
  owner.page.once('dialog', (d) => { void d.accept(); });
  await owner.page.getByRole('button', { name: 'Leave team' }).click();
  await expect(owner.page.getByLabel('Team', { exact: true })).toContainText('Create a team to share one plan');
  await m.page.reload();
  await expect(members(m.page)).toHaveCount(1);
  await owner.ctx.close(); await m.ctx.close();
});

test('signing in again keeps the team (it is attached to the account, not the browser)', async ({ browser }) => {
  const owner = await person(browser, 'persist');
  await owner.page.goto('/account');
  await owner.page.getByLabel('What should the team be called?').fill('Sticky Team');
  await owner.page.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Sticky Team' })).toBeVisible();
  const fresh = await browser.newContext(); const fp = await fresh.newPage();
  await login(fp, owner.email, PW);
  await expect(fp).toHaveURL(/\/account$/);
  await expect(fp.getByRole('heading', { name: 'Sticky Team' })).toBeVisible();
  await fresh.close(); await owner.ctx.close();
});
