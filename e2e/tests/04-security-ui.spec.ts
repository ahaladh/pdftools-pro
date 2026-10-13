import { test, expect } from '@playwright/test';
import { file, login, makePdf, register, uniqueEmail, watchConsole } from '../support/helpers';

const PW = 'e2e-Passw0rd-original';

test.describe('security as the browser experiences it', () => {
  test('credentials: the access token is memory-only; the refresh cookie is httpOnly + SameSite=Strict; nothing sensitive in storage', async ({ page, context }) => {
    const email = uniqueEmail('cookies');
    await register(page, email, PW);
    const cookies = await context.cookies();
    const refresh = cookies.find((c) => c.name === 'pt_refresh')!;
    expect(refresh.httpOnly).toBe(true);
    expect(refresh.sameSite).toBe('Strict');
    expect(refresh.path).toBe('/api/auth');
    const guest = cookies.find((c) => c.name === 'pt_guest');
    if (guest) expect(guest.httpOnly).toBe(true);
    const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(leaked).not.toMatch(/eyJ[\w-]+\.[\w-]+\./); // no JWT anywhere script can read
    expect(leaked).not.toContain('pt_refresh');
    expect(leaked).not.toContain(PW);
  });

  test('user-controlled text is rendered as text, never as HTML (name, filenames)', async ({ page }) => {
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await register(page, uniqueEmail('xss'), PW, payload);
    await expect(page.getByLabel('Name')).toHaveValue(payload);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    await page.goto('/merge');
    await page.setInputFiles('input[type=file]', [file('<img src=x onerror=window.__xss=3>.pdf', await makePdf(1)), file('b.pdf', await makePdf(1))]);
    await expect(page.getByText('<img src=x onerror=window.__xss=3>.pdf')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('open redirect: ?next= pointing off-site or protocol-relative lands on our own account page', async ({ page }) => {
    const email = uniqueEmail('redirect');
    await register(page, email, PW);
    await page.getByRole('button', { name: 'Sign out' }).click();
    for (const next of ['//evil.example/phish', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      await login(page, email, PW, next);
      await expect(page).toHaveURL(/localhost:\d+\/account$/);
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
    await login(page, email, PW, '/pricing'); // a legitimate same-site target is honoured
    await expect(page).toHaveURL(/\/pricing$/);
  });

  test('security headers are present on pages; framing is forbidden; CSP holds across the app', async ({ page }) => {
    const mon = watchConsole(page);
    for (const path of ['/', '/tools', '/pricing', '/signin', '/register', '/privacy', '/merge', '/edit', '/organize']) {
      const res = await page.goto(path);
      const h = res!.headers();
      expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
      expect(h['x-frame-options'], path).toBe('DENY');
      expect(h['x-content-type-options'], path).toBe('nosniff');
      expect(h['referrer-policy'], path).toBeTruthy();
    }
    expect(await mon.cspViolations()).toEqual([]);
    // What an XSS payload would do: put an inline <script> into the DOM. The policy must stop it and report it.
    // (page.evaluate itself runs via DevTools and is exempt from CSP, so it cannot be used to test eval directly.)
    await page.goto('/');
    await page.evaluate(() => {
      const s = document.createElement('script'); s.textContent = 'window.__inlineRan = 1'; document.body.appendChild(s);
      const h = document.createElement('img'); h.setAttribute('onerror', 'window.__handlerRan = 1'); h.src = 'x:'; document.body.appendChild(h);
    });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __inlineRan?: number }).__inlineRan)).toBeUndefined();
    expect(await page.evaluate(() => (window as unknown as { __handlerRan?: number }).__handlerRan)).toBeUndefined();
    expect((await mon.cspViolations()).some((v) => v.startsWith('script-src'))).toBe(true); // the browser reported the block
  });

  test("one user's results are not reachable by another browser, even with the full signed link", async ({ page, browser }) => {
    await register(page, uniqueEmail('owner'), PW);
    await page.goto('/rotate');
    await page.setInputFiles('input[type=file]', file('mine.pdf', await makePdf(1)));
    await page.getByRole('button', { name: 'Rotate PDF' }).click();
    await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
    const jobs = await page.evaluate(async () => {
      const t = (await (await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-PDFTools-CSRF': '1' } })).json()).data.accessToken as string;
      const list = (await (await fetch('/api/me/jobs', { headers: { Authorization: `Bearer ${t}` } })).json()).data as { id: string; result?: { downloadUrl: string } }[];
      return list.filter((j) => j.result);
    });
    const link = jobs[0]!.result!.downloadUrl;
    const stranger = await browser.newContext();
    const res = await stranger.request.get(`${new URL(page.url()).origin}${link}`);
    expect(res.status()).toBe(404);
    const anon = await stranger.request.get(`${new URL(page.url()).origin}/api/jobs/${jobs[0]!.id}`);
    expect(anon.status()).toBe(404);
    await stranger.close();
  });

  test('a stale or tampered session degrades to signed-out instead of breaking the page', async ({ page, context }) => {
    await register(page, uniqueEmail('stale'), PW);
    await context.clearCookies({ name: 'pt_refresh' }); // refresh token gone, but the localStorage hint remains
    await page.goto('/account');
    await expect(page).toHaveURL(/\/signin/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pt_signed_in'))).toBeNull(); // hint cleared on a definitive rejection
  });

  test('when the API is unreachable the app keeps the session and offers a retry (does not sign the user out)', async ({ page, context }) => {
    await register(page, uniqueEmail('outage'), PW);
    await page.route('**/api/auth/refresh', (r) => r.abort());
    await page.goto('/account');
    await expect(page.getByText("couldn't reach the server")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('pt_signed_in'))).toBe('1');
    await page.unroute('**/api/auth/refresh');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    void context;
  });
});
