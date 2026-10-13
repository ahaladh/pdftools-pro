import { test, expect } from '@playwright/test';
import { file, lastResetLink, login, makePdf, register, uniqueEmail, watchConsole } from '../support/helpers';

const PW = 'e2e-Passw0rd-original';

async function runRotate(page: import('@playwright/test').Page, name = 'doc.pdf') {
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file(name, await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
}

test.describe('accounts', () => {
  test('register, stay signed in across reloads, hit the daily quota, sign out and in again', async ({ page }) => {
    const mon = watchConsole(page);
    const email = uniqueEmail('quota');
    await register(page, email, PW);
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText('0 / 3')).toBeVisible();
    await page.reload(); // session restored from the httpOnly refresh cookie
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    for (let i = 0; i < 3; i++) {
      await runRotate(page, `d${i}.pdf`);
      await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    }
    await runRotate(page, 'fourth.pdf');
    await expect(page.getByRole('alert')).toContainText("today's limit of 3 operations");
    await expect(page.getByRole('alert').getByRole('link', { name: 'See plans and limits' })).toBeVisible();
    await expect(page.getByRole('alert').getByRole('link', { name: 'Create a free account' })).toHaveCount(0); // signed in: no sign-up nag

    await page.goto('/account');
    await expect(page.getByText('3 / 3')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Recent jobs' })).toContainText('Rotate PDF');
    // history download goes through authenticated fetch
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download d\d\.pdf|Download .*rotated/i }).first().click()]);
    expect(dl.suggestedFilename()).toMatch(/rotated\.pdf$/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/');
    await page.goto('/account');
    await expect(page).toHaveURL(/\/signin/); // protected route
    await login(page, email, PW, '/account');
    await expect(page).toHaveURL(/\/account$/);
    expect(mon.problems.filter((p) => !/401|403|429/.test(p))).toEqual([]); // expected API errors aside, no JS errors
    expect(await mon.cspViolations()).toEqual([]);
  });

  test('wrong credentials give one generic message; the form never reveals which part was wrong', async ({ page }) => {
    const email = uniqueEmail('wrongpw');
    await register(page, email, PW);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, email, 'definitely-wrong-password');
    const a = await page.getByRole('alert').textContent();
    await login(page, uniqueEmail('nobody'), 'definitely-wrong-password');
    expect(await page.getByRole('alert').textContent()).toBe(a);
    expect(a).toMatch(/incorrect email or password/i);
  });

  test('client validation: weak password and malformed email are caught before sending', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Invalid email')).toBeVisible();
    await expect(page.getByText('Use at least 10 characters').first()).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('forgot + reset password via the emailed link, then old password stops working', async ({ page }) => {
    const email = uniqueEmail('reset');
    await register(page, email, PW);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('reset link is on its way');
    // an unknown address gets the identical answer
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(uniqueEmail('ghost'));
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('reset link is on its way');

    let link = '';
    await expect.poll(() => { try { link = lastResetLink(); return link; } catch { return ''; } }, { timeout: 8000 }).toContain('/reset-password?token=');
    await page.goto(link);
    await page.getByLabel('New password').fill('e2e-Passw0rd-brand-new');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Your password was changed')).toBeVisible();
    await page.goto(link); // the link is single-use
    await page.getByLabel('New password').fill('e2e-Passw0rd-attacker');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid or has expired/i);

    await login(page, email, PW);
    await expect(page.getByRole('alert')).toBeVisible();
    await login(page, email, 'e2e-Passw0rd-brand-new');
    await expect(page).toHaveURL(/\/account$/);
  });

  test('change password signs other sessions out; delete account removes everything', async ({ page, browser }) => {
    const email = uniqueEmail('lifecycle');
    await register(page, email, PW);
    // second device
    const other = await browser.newContext();
    const op = await other.newPage();
    await login(op, email, PW);
    await expect(op).toHaveURL(/\/account$/);

    await page.getByLabel('Current password').first().fill(PW);
    await page.getByLabel('New password').fill('e2e-Passw0rd-changed');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Other devices were signed out')).toBeVisible();
    await op.reload();
    await expect(op).toHaveURL(/\/signin/); // its refresh token was revoked
    await other.close();

    await page.getByLabel('Confirm with your password').fill('e2e-Passw0rd-changed');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page).toHaveURL('/');
    await login(page, email, 'e2e-Passw0rd-changed');
    await expect(page.getByRole('alert')).toContainText(/incorrect email or password/i);
  });

  test('premium gating for a signed-in free user points to pricing; pricing shows real plan numbers', async ({ page }) => {
    await register(page, uniqueEmail('free'), PW);
    await page.goto('/compare');
    await page.setInputFiles('input[type=file]', [file('a.pdf', await makePdf(1)), file('b.pdf', await makePdf(1))]);
    await page.getByRole('button', { name: 'Compare PDFs' }).click();
    await expect(page.getByRole('alert')).toContainText(/not included in your plan/i);
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: 'Pro' })).toBeVisible();
    await expect(page.getByText('$9')).toBeVisible();
    await expect(page.getByText('Not available for purchase yet').first()).toBeVisible(); // Stripe is not configured in e2e: nothing is faked
  });
});
