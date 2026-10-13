import { defineConfig } from '@playwright/test';

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
    // Use the Chrome already installed on the machine/CI image: no browser download needed.
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
});
