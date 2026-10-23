import { defineConfig } from '@playwright/test';

// E2E_BROWSER=firefox|webkit runs the suite on another engine (default: the installed Chrome).
const engine = process.env.E2E_BROWSER ?? 'chrome';
const web = `http://localhost:${process.env.E2E_WEB_PORT ?? 4173}`;
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  // One shared stack with shared state (accounts, quotas): run serially.
  workers: 1, fullyParallel: false,
  timeout: 90_000, expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: web,
    // Chrome: the one already installed on the machine/CI image. Firefox/WebKit: Playwright's own builds.
    ...(engine === 'chrome' ? { channel: 'chrome' } : { browserName: engine as 'firefox' | 'webkit' }),
    headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
