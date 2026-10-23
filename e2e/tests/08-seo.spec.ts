import { test, expect, type Browser } from '@playwright/test';
import { TOOLS } from '@pdftools/shared';
import { NGINX, startEdge, type Edge } from '../support/edge';

/**
 * What a crawler that does not run JavaScript sees, served the way production serves it: by nginx (`try_files` resolves
 * /merge -> /merge/index.html). `vite preview` cannot be used for this: its SPA fallback answers every path with the home page.
 * The e2e build runs with SITE_URL=http://localhost:4173, so canonical URLs and the sitemap use that origin.
 */
const SITE = `http://localhost:${process.env.E2E_WEB_PORT ?? 4173}`;
test.skip(!NGINX && !process.env.CI, 'nginx not available: set NGINX_BIN');
test.use({ ignoreHTTPSErrors: true });
let edge: Edge; let BASE = '';
test.beforeAll(() => { edge = startEdge({ apiAddr: '127.0.0.1:4101', httpPort: 4380, httpsPort: 4343 }); BASE = edge.httpsUrl; });
test.afterAll(() => edge?.stop());
const routes = ['/', '/tools', '/view', '/privacy', '/terms', ...TOOLS.map((t) => `/${t.id}`)];

async function noJs(browser: Browser) { return browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true }); }

test.describe('search-engine view (JavaScript disabled)', () => {
  test('every public page ships real, unique, correct metadata and content in its HTML', async ({ browser }) => {
    const ctx = await noJs(browser); const page = await ctx.newPage();
    const titles = new Set<string>(), descriptions = new Set<string>();
    for (const route of routes) {
      const res = await page.goto(BASE + route);
      expect(res!.status(), route).toBe(200);
      const title = await page.title();
      expect(title, route).not.toMatch(/^PDFTools Pro – Every PDF tool you need$/); // not the generic shell title
      titles.add(title);
      const desc = await page.locator('meta[name=description]').getAttribute('content');
      expect(desc!.length, route).toBeGreaterThan(40);
      descriptions.add(desc!);
      expect(await page.locator('link[rel=canonical]').getAttribute('href'), route).toBe(`${SITE}${route}`);
      expect(await page.locator('meta[property="og:title"]').getAttribute('content'), route).toBeTruthy();
      expect(await page.locator('meta[name=robots]').getAttribute('content'), route).toBe('index,follow');
      expect(await page.locator('h1').count(), `${route} h1 count`).toBe(1);
      expect((await page.locator('main').innerText()).length, `${route} body text`).toBeGreaterThan(150);
      for (const ld of await page.locator('script[type="application/ld+json"]').all()) JSON.parse((await ld.textContent())!); // valid JSON-LD
      expect((await page.content()).length, route).toBeLessThan(120_000);
    }
    expect(titles.size).toBe(routes.length);        // no duplicate titles
    expect(descriptions.size).toBeGreaterThanOrEqual(routes.length - 1);
    await ctx.close();
  });

  test('tool pages carry their FAQ as structured data and their explanation as text', async ({ browser }) => {
    const ctx = await noJs(browser); const page = await ctx.newPage();
    await page.goto(`${BASE}/compress`);
    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!);
    const types = (ld['@graph'] as { '@type': string }[]).map((n) => n['@type']);
    expect(types).toContain('WebApplication'); expect(types).toContain('FAQPage');
    await expect(page.locator('main')).toContainText('How much smaller will my file be?');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
    await ctx.close();
  });

  test('crawlers can discover pages: /tools links to every available tool, sitemap and robots are correct', async ({ browser, request }) => {
    const ctx = await noJs(browser); const page = await ctx.newPage();
    await page.goto(`${BASE}/tools`);
    const hrefs = await page.locator('main a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    for (const t of TOOLS) expect(hrefs, t.id).toContain(`/${t.id}`);
    await ctx.close();
    const sitemap = await (await request.get(`${BASE}/sitemap.xml`)).text();
    for (const r of routes) expect(sitemap).toContain(`<loc>${SITE}${r}</loc>`); // same form as each page's canonical URL
    expect((sitemap.match(/<loc>/g) ?? []).length).toBeGreaterThanOrEqual(routes.length);
    const robots = await (await request.get(`${BASE}/robots.txt`)).text();
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  test('private and dynamic pages are NOT prerendered and are marked noindex once the app runs', async ({ browser, page }) => {
    const ctx = await noJs(browser); const p = await ctx.newPage();
    await p.goto(`${BASE}/account`);
    await expect(p.locator('#root')).toBeEmpty();  // the empty app shell: no account data can ever be baked into static HTML
    await ctx.close();
    await page.goto('/signin');
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
  });

  test('with JavaScript the page still comes alive over the prerendered markup (no flash of wrong content)', async ({ page }) => {
    await page.goto('/merge');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Merge PDF');
    await expect(page.getByText('Drop your files here')).toBeVisible(); // the interactive upload area replaced the static snapshot
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pricing');
    await page.goto('/definitely-not-a-page');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible(); // unknown routes got the neutral shell, not the home snapshot
  });
});
