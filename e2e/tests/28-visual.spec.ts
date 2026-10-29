import { test, expect, type Page } from '@playwright/test';
import { makePdf, file } from '../support/helpers';

/**
 * Visual regression: key screens compared pixel for pixel with committed baselines (Chromium only).
 *
 * Screenshots depend on the browser build, fonts and OS, so baselines are only meaningful where they were made. They are made on
 * the CI runner (workflow "CI" > Run workflow > update_visual_baselines), downloaded from the run's artifact and committed to
 * `28-visual.spec.ts-snapshots/`. CI compares against them; a pull request that changes how a page looks must refresh them on purpose.
 * Locally this spec is skipped unless E2E_VISUAL=1 (and then only agrees with baselines made on an identical setup).
 *
 * What is held still so the same page gives the same pixels: a fixed clock (the footer shows the year), animations and the caret
 * off, a fixed window size, fonts loaded first. What it does NOT catch: anything not on these screens, hover/focus states, other
 * browsers, dark mode.
 */
test.skip(({ browserName }) => browserName !== 'chromium', 'baselines are Chromium-only');
test.skip(!process.env.E2E_VISUAL, 'set E2E_VISUAL=1 (CI does) to run the visual comparisons');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });

async function settle(page: Page) {
  await page.clock.setFixedTime(new Date('2026-01-15T12:00:00Z'));
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForLoadState('networkidle');
}
const shot = async (page: Page, name: string, fullPage = true) => {
  await settle(page);
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage, animations: 'disabled', caret: 'hide', maxDiffPixels: 20 });
};

const SCREENS: [string, string][] = [
  ['home', '/'], ['pricing', '/pricing'], ['all-tools', '/tools'], ['merge-empty', '/merge'], ['sign-in', '/signin'],
  ['register', '/register'], ['privacy', '/privacy'], ['viewer-empty', '/view'], ['not-found', '/this-page-does-not-exist'],
];
for (const [name, path] of SCREENS) {
  test(`${name} looks the same`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-15T12:00:00Z') });
    await page.goto(path);
    await shot(page, name);
  });
}

test('merge with two files added looks the same', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-15T12:00:00Z') });
  await page.goto('/merge');
  await page.setInputFiles('input[type=file]', [file('first.pdf', await makePdf(2, { label: 'First' })), file('second.pdf', await makePdf(3, { label: 'Second' }))]);
  await expect(page.getByText('first.pdf')).toBeVisible();
  await expect(page.getByText('second.pdf')).toBeVisible();
  await shot(page, 'merge-two-files');
});

test('the phone layout of the home and pricing pages looks the same', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date('2026-01-15T12:00:00Z') });
  await page.goto('/');
  await shot(page, 'home-phone');
  await page.goto('/pricing');
  await shot(page, 'pricing-phone');
});
