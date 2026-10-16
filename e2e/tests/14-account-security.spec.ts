import { test, expect, type Page, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { authenticatorCode, lastEmailLink, login, register, uniqueEmail, watchConsole } from '../support/helpers';
import { readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};

/** Turn two-step verification on through the UI; returns the key the app displayed and the recovery codes. */
async function enableTwoFactor(page: Page) {
  await page.goto('/account');
  await page.getByRole('button', { name: 'Set up' }).click();
  await page.getByLabel('Your password, to set up two-step verification').fill(PW);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const key = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code').fill(authenticatorCode(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const list = page.getByRole('list', { name: 'Your recovery codes' });
  await expect(list).toBeVisible();
  const recovery = (await list.getByRole('listitem').allInnerTexts()).map((s) => s.trim());
  await page.getByRole('button', { name: 'I have saved them' }).click();
  return { key, recovery };
}
const signOut = async (page: Page) => { await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page).toHaveURL(/\/$/); };

test.describe('email confirmation', () => {
  test('the emailed link confirms the address once; the banner goes away; a reused link is explained', async ({ page }) => {
    const mon = watchConsole(page);
    await register(page, uniqueEmail('verify'), PW);
    await expect(page.getByLabel('Email confirmation')).toContainText('Confirm your email address');
    const link = lastEmailLink('verify-email');
    await page.goto(link);
    await expect(page.getByText('your email address is confirmed')).toBeVisible();
    await page.goto('/account');
    await expect(page.getByLabel('Email confirmation')).toHaveCount(0);
    await page.goto(link); // second use of the same link
    await expect(page.getByRole('alert')).toContainText(/invalid or has expired/i);
    // the browser logs the expected 400 of the reused link; anything else would be a real problem
    expect(mon.problems.filter((p) => !/status of 400/.test(p))).toEqual([]);
  });

  test('resend is rate limited with a clear message; a link with no token is explained', async ({ page }) => {
    await register(page, uniqueEmail('resend'), PW);
    await page.getByRole('button', { name: 'Resend email' }).click();
    await expect(page.getByRole('alert')).toContainText(/wait \d+ seconds/i); // just registered: inside the cooldown
    await page.goto('/verify-email');
    await expect(page.getByRole('alert')).toContainText(/incomplete/i);
  });
});

test.describe('two-step verification', () => {
  test('set up, then sign in needs the code; wrong codes and reuse are refused; a recovery code works once', async ({ page }) => {
    const mon = watchConsole(page);
    const email = uniqueEmail('twofa');
    await register(page, email, PW);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Set up' }).click();
    await page.getByLabel('Your password, to set up two-step verification').fill('definitely-not-it');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText(/password is incorrect/i);
    await page.getByLabel('Your password, to set up two-step verification').fill(PW);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
    await axe(page, 'two-factor setup');
    const key = (await page.getByLabel('Setup key').innerText()).replace(/\s/g, '');
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    await page.getByLabel('6-digit code').fill(authenticatorCode(key));
    await page.getByRole('button', { name: 'Turn on' }).click();
    const list = page.getByRole('list', { name: 'Your recovery codes' });
    await expect(list).toBeVisible();
    const recovery = (await list.getByRole('listitem').allInnerTexts()).map((s) => s.trim());
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    await axe(page, 'recovery codes');
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.getByText('On. Signing in needs a code')).toBeVisible();

    await signOut(page);
    // password alone no longer signs in
    await page.goto('/signin');
    await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(PW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/account/);
    await axe(page, 'two-step sign-in');
    await page.getByLabel('Authentication code').fill('000000');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    // the code used to enable it is spent; the next one is accepted. Compute it ONCE: a replay is the very same string,
    // and recomputing later could land in a different 30 s period (and so be a different, valid code).
    const nextCode = authenticatorCode(key, 1);
    await page.getByLabel('Authentication code').fill(nextCode);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText('On. Signing in needs a code')).toBeVisible();

    // the same authenticator code cannot be used again
    await signOut(page);
    await login(page, email, PW);
    await page.getByLabel('Authentication code').fill(nextCode);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid/i);

    // a recovery code works once, in any case/spacing
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(` ${recovery[0]!.toUpperCase().replace('-', ' ')} `);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    await signOut(page);
    await login(page, email, PW);
    await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
    await page.getByLabel('Recovery code').fill(recovery[0]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    await page.getByLabel('Recovery code').fill(recovery[1]!);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(page).toHaveURL(/\/account$/);
    expect(mon.problems.filter((p) => !/40[013]|429/.test(p)), 'unexpected console problems').toEqual([]);
  });

  test('turning it off needs the password and a code, and sign-in is password-only again', async ({ page }) => {
    const email = uniqueEmail('off');
    await register(page, email, PW);
    const { key } = await enableTwoFactor(page);
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByLabel('Authenticator or recovery code').fill('000000');
    await page.getByRole('button', { name: 'Turn off' }).last().click();
    await expect(page.getByRole('alert')).toContainText(/not valid/i);
    await page.getByLabel('Authenticator or recovery code').fill(authenticatorCode(key, 1));
    await page.getByRole('button', { name: 'Turn off' }).last().click();
    await expect(page.getByText('Off. Add a second step')).toBeVisible();
    await signOut(page);
    await login(page, email, PW);
    await expect(page).toHaveURL(/\/account$/); // no second step
  });
});

test.describe('signed-in devices', () => {
  const second = async (browser: Browser, email: string) => {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120' });
    const p = await ctx.newPage();
    await login(p, email, PW);
    await expect(p).toHaveURL(/\/account$/);
    return { ctx, p };
  };

  test('lists this device and others, and signing another device out takes effect there', async ({ page, browser }) => {
    const email = uniqueEmail('devices');
    await register(page, email, PW);
    const other = await second(browser, email);
    await page.goto('/account');
    const list = page.getByRole('list', { name: 'Signed-in devices' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('This device');
    await expect(list).toContainText('Edge on Windows');
    await axe(page, 'devices');
    await page.getByRole('button', { name: /^Sign out Edge on Windows$/ }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    // the other browser is signed out as soon as it needs to refresh
    await other.p.reload();
    await expect(other.p).toHaveURL(/\/signin/);
    await other.ctx.close();
  });

  test('"sign out all other devices" leaves only this one', async ({ page, browser }) => {
    const email = uniqueEmail('devices2');
    await register(page, email, PW);
    const a = await second(browser, email), b = await second(browser, email);
    await page.goto('/account');
    await expect(page.getByRole('list', { name: 'Signed-in devices' }).getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Sign out all other devices' }).click();
    await expect(page.getByRole('list', { name: 'Signed-in devices' }).getByRole('listitem')).toHaveCount(1);
    for (const x of [a, b]) { await x.p.reload(); await expect(x.p).toHaveURL(/\/signin/); await x.ctx.close(); }
    await page.reload();
    await expect(page.getByText('This device')).toBeVisible(); // this one is still signed in
  });
});

test.describe('support: locked out of two-step verification', () => {
  test('an administrator can reset it, and the user can then sign in with the password alone', async ({ page, browser }) => {
    const email = uniqueEmail('locked');
    const userCtx = await browser.newContext(); const up = await userCtx.newPage();
    await register(up, email, PW);
    await enableTwoFactor(up);
    await signOut(up);

    const a = readState();
    await login(page, a.adminEmail, a.adminPassword, '/admin');
    await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
    await page.getByRole('tab', { name: 'Users' }).click();
    await page.getByLabel('Search users by email').fill(email);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('cell', { name: email, exact: true })).toBeVisible();
    page.once('dialog', (d) => { expect(d.message()).toMatch(/confirming their identity/); void d.accept(); });
    await page.getByRole('button', { name: `Reset two-step verification for ${email}` }).click();
    await expect(page.getByRole('button', { name: `Reset two-step verification for ${email}` })).toHaveCount(0);

    await login(up, email, PW);
    await expect(up).toHaveURL(/\/account$/); // password alone works again
    await expect(up.getByText('Off. Add a second step')).toBeVisible();
    await userCtx.close();
  });
});
