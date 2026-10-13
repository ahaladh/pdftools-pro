import { test, expect, type Page } from '@playwright/test';
import { file, login, makePdf, register, uniqueEmail } from '../support/helpers';
import { readState } from '../support/stack';

const PW = 'e2e-Passw0rd-original';
const loginAdmin = async (page: Page) => { const s = readState(); await login(page, s.adminEmail, s.adminPassword, '/admin'); await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible(); };

test.describe('admin', () => {
  test('regular users cannot reach the admin UI or API', async ({ page }) => {
    await register(page, uniqueEmail('plain'), PW);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/account$/); // UI guard
    // the real protection is the API: call it with the user's own token
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-PDFTools-CSRF': '1' } });
      const t = (await r.json()).data.accessToken as string;
      const a = await fetch('/api/admin/users', { headers: { Authorization: `Bearer ${t}` } });
      const b = await fetch('/api/admin/settings', { method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: '{}' });
      return [a.status, b.status];
    });
    expect(status).toEqual([403, 403]);
  });

  test('dashboard, user management (plan change takes effect), jobs and audit log', async ({ page, browser }) => {
    // a user to manage
    const email = uniqueEmail('managed');
    const ctx = await browser.newContext(); const up = await ctx.newPage();
    await register(up, email, PW);
    await expect(up.getByText('Current plan:')).toContainText(/free/i); // capitalised by CSS only

    await loginAdmin(page);
    await expect(page.getByText('Registered users')).toBeVisible();
    await expect(page.getByText('Storage in use')).toBeVisible();
    await page.getByRole('tab', { name: 'Users' }).click();
    await page.getByLabel('Search users by email').fill(email);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('cell', { name: email })).toBeVisible();
    await page.getByLabel(`Plan for ${email}`).selectOption('pro');
    await expect(page.getByLabel(`Plan for ${email}`)).toHaveValue('pro');

    await up.reload();
    await expect(up.getByText('Current plan:')).toContainText(/pro/i); // entitlements changed immediately
    await expect(up.getByText(/\/ 1000/)).toBeVisible();

    await page.getByRole('tab', { name: 'Jobs' }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('tab', { name: 'Audit log' }).click();
    await expect(page.getByRole('cell', { name: 'admin.user_updated' }).first()).toBeVisible();
    await ctx.close();
  });

  test('disabling a user signs them out at once and blocks sign-in', async ({ page, browser }) => {
    const email = uniqueEmail('suspend');
    const ctx = await browser.newContext(); const up = await ctx.newPage();
    await register(up, email, PW);
    await loginAdmin(page);
    await page.getByRole('tab', { name: 'Users' }).click();
    await page.getByLabel('Search users by email').fill(email);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByLabel(`Status for ${email}`).selectOption('disabled');
    await expect(page.getByLabel(`Status for ${email}`)).toHaveValue('disabled');
    await up.reload();
    await expect(up).toHaveURL(/\/signin/);
    await login(up, email, PW);
    await expect(up.getByRole('alert')).toContainText(/disabled/i);
    await ctx.close();
  });

  test('settings: disabling a tool and maintenance mode take effect for visitors; reverting restores service', async ({ page, browser }) => {
    await loginAdmin(page);
    await page.getByRole('tab', { name: 'Settings' }).click();
    const rotate = page.getByRole('checkbox', { name: 'Rotate PDF' }).first(); // first group = "Disabled tools"
    await rotate.check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();

    const guest = await browser.newContext(); const gp = await guest.newPage();
    await gp.goto('/rotate');
    await gp.setInputFiles('input[type=file]', file('a.pdf', await makePdf(1)));
    await gp.getByRole('button', { name: 'Rotate PDF' }).click();
    await expect(gp.getByRole('alert')).toContainText(/temporarily disabled/i);

    await page.getByRole('checkbox', { name: 'Rotate PDF' }).first().uncheck();
    await page.getByRole('checkbox', { name: /Maintenance mode/ }).check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await gp.goto('/merge');
    await expect(gp.getByText(/maintenance mode/i)).toBeVisible();
    await expect(gp.getByRole('button', { name: 'Merge PDF' })).toHaveCount(0);

    await page.getByRole('checkbox', { name: /Maintenance mode/ }).uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await gp.goto('/rotate');
    await gp.setInputFiles('input[type=file]', file('a.pdf', await makePdf(1)));
    await gp.getByRole('button', { name: 'Rotate PDF' }).click();
    await expect(gp.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    await guest.close();
  });

  test('settings validation: impossible values are rejected with a message and nothing is saved', async ({ page }) => {
    await loginAdmin(page);
    await page.getByRole('tab', { name: 'Settings' }).click();
    const maxFile = page.getByLabel('Max file (MB)').nth(2); // Pro plan
    await maxFile.evaluate((el) => el.removeAttribute('min')); // emulate a tampered client: the browser's own min= would otherwise block submit
    await maxFile.fill('-5');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByLabel('Max file (MB)').nth(2)).toHaveValue('200');
  });

  test('redaction removes the text for real (admin has the Business plan, so premium tools work)', async ({ page }) => {
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    await loginAdmin(page);
    await page.goto('/redact');
    const pdf = await makePdf(2, { label: 'SECRETWORD' });
    await page.setInputFiles('input[type=file]', file('secret.pdf', pdf));
    const svg = page.locator('svg.touch-none');
    await page.getByRole('button', { name: 'Fit to page' }).click();
    await page.getByRole('button', { name: 'Redact area' }).click();
    await svg.scrollIntoViewIfNeeded();
    const b = (await svg.boundingBox())!;
    // the label sits ~14-20% from the top of a 300x400 page
    await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.12); await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.24, { steps: 6 }); await page.mouse.up();
    await expect(page.getByText('1 item total')).toBeVisible();
    await page.getByRole('button', { name: 'Apply redactions' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const path = await dl.path();
    const out = execFileSync('pdftotext', [path, '-']).toString();
    expect(out).not.toContain('SECRETWORD page 1');
    expect(out).toContain('SECRETWORD page 2'); // untouched page stays selectable
    expect(readFileSync(path).toString('latin1')).not.toContain('SECRETWORD page 1');
    void writeFileSync; void mkdtempSync; void tmpdir; void join;
  });
});
