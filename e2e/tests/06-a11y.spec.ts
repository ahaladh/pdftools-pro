import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { file, makePdf, register, uniqueEmail } from '../support/helpers';

const PUBLIC = ['/', '/tools', '/pricing', '/signin', '/register', '/forgot-password', '/privacy', '/terms', '/merge', '/organize', '/edit', '/compress'];

test.describe('accessibility (axe, WCAG 2.1 A/AA)', () => {
  for (const path of PUBLIC) {
    test(`no violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    });
  }

  test('signed-in and workspace screens have no violations', async ({ page }) => {
    await register(page, uniqueEmail('a11y'), 'e2e-Passw0rd-original');
    const check = async (label: string) => {
      await page.waitForLoadState('networkidle');
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
    };
    await check('account');
    await page.goto('/edit');
    await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(2)));
    await expect(page.locator('svg.touch-none')).toBeVisible();
    await check('editor');
    await page.goto('/organize');
    await page.setInputFiles('input[type=file]', file('doc.pdf', await makePdf(3)));
    await expect(page.getByText('3 pages in the result')).toBeVisible();
    await check('organizer');
  });

  test('keyboard: skip link works, controls show a visible focus ring, and a merge can be completed without a mouse for reordering', async ({ page }) => {
    await page.goto('/merge');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await page.setInputFiles('input[type=file]', [file('a.pdf', await makePdf(1)), file('b.pdf', await makePdf(1))]);
    const down = page.getByRole('button', { name: 'Move a.pdf down' });
    await down.focus();
    const outline = await down.evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('list', { name: 'Selected files' }).getByRole('listitem').first()).toContainText('b.pdf');
  });

  test('mobile layout: no horizontal scrolling on key pages at 375px', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
    const page = await ctx.newPage();
    for (const path of ['/', '/tools', '/pricing', '/signin', '/merge', '/privacy']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${path} overflows by ${over}px`).toBeLessThanOrEqual(1);
    }
    await ctx.close();
  });
});
