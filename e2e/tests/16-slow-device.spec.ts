import { test, expect } from '@playwright/test';
import { register, uniqueEmail } from '../support/helpers';

/**
 * A slow phone or a small CI runner renders React much later than a developer machine. Signing out used to navigate home, wait a
 * fixed 50 ms and then clear the session, so on a slow device the still-mounted account route redirected to /signin?next=/.
 * Throttling the browser's CPU reproduces that reliably; the outcome must not depend on speed.
 */
for (const rate of [1, 6, 12]) {
  test(`signing out always ends on the home page, with the browser CPU throttled ${rate}x`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'CPU throttling is a Chrome DevTools Protocol feature (Firefox/WebKit have no equivalent in Playwright)');
    await register(page, uniqueEmail('slow'), 'e2e-Passw0rd-original');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/', { timeout: 15_000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.goto('/account'); // and the account really is signed out: a protected page sends you to sign in
    await expect(page).toHaveURL(/\/signin\?next=%2Faccount/);
  });
}
