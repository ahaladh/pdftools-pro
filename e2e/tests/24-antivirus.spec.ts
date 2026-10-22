import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { file, makePdf, watchConsole } from '../support/helpers';
import { API_PORT, ROOT, WEB_PORT, readState } from '../support/stack';
import { EICAR, FakeClamd } from '../../apps/api/src/testing/fakeclamd';

/**
 * Virus scanning in the browser: a second API and web server with AV_MODE=enforce, talking to a stand-in for ClamAV's daemon that
 * speaks its wire protocol (see apps/api/src/testing/fakeclamd.ts). Not covered, because it needs ClamAV itself: real signatures,
 * clamd's own limits, and its behaviour under load.
 */
const WEB4 = WEB_PORT + 40, API4 = API_PORT + 40;
const web4 = `http://localhost:${WEB4}`, api4 = `http://localhost:${API4}`;
test.use({ baseURL: web4 });
test.describe.configure({ mode: 'serial' });

const clamd = new FakeClamd();
const kids: ChildProcess[] = [];
const up = async (url: string) => { for (let i = 0; i < 240; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`${url} did not come up`); };
const axe = async (page: Page, label: string) => {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.length}) e.g. ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
};
const infected = async (name: string) => file(name, Buffer.concat([await makePdf(1), Buffer.from(`\n% ${EICAR}\n`)]));

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const s = readState();
  await clamd.start();
  mkdirSync(join(ROOT, 'e2e/.logs'), { recursive: true });
  const out = createWriteStream(join(ROOT, 'e2e/.logs/av-stack.log'));
  const start = (cmd: string, args: string[], env: Record<string, string>, cwd: string) => {
    const p = spawn(cmd, args, { cwd, env: { ...env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    p.stdout?.pipe(out); p.stderr?.pipe(out); kids.push(p);
  };
  start(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], { ...s.env, PORT: String(API4), CORS_ORIGINS: web4, PUBLIC_URL: web4, QUEUE_DRIVER: 'inline', AV_MODE: 'enforce', CLAMD_PORT: String(clamd.port), AV_TIMEOUT_SECONDS: '3' }, join(ROOT, 'apps/api'));
  await up(`${api4}/health`);
  start(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(WEB4), '--strictPort', '--host', 'localhost'], { API_URL: api4 }, join(ROOT, 'apps/web'));
  await up(`${web4}/`);
});
test.afterAll(async () => { for (const p of kids) { try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } } await clamd.stop(); });
test.beforeEach(() => clamd.reset());

test('clean files go through; an infected file is refused with a clear message; an outage pauses uploads and says so', async ({ page }) => {
  test.setTimeout(120_000);
  const mon = watchConsole(page);

  // a clean file is scanned and processed as usual
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file('clean.pdf', await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
  expect(clamd.seen.streams).toHaveLength(1);
  expect(clamd.seen.streams[0]).toMatchObject({ terminated: true });

  // an infected one is refused before anything is processed
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', await infected('invoice.pdf'));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'was blocked' });
  await expect(alert).toContainText('"invoice.pdf" was blocked: our virus scan found something harmful in it. Nothing was processed.');
  await expect(alert).not.toContainText(/eicar|signature/i);
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toHaveCount(0);
  await axe(page, 'blocked upload');

  // the scanner cannot answer: uploads are paused, in plain words, with nothing technical shown
  clamd.behaviour = 'garbage';
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file('later.pdf', await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  const paused = page.getByRole('alert').filter({ hasText: 'File scanning is temporarily unavailable' });
  await expect(paused).toBeVisible();
  await expect(paused).not.toContainText(/clamd|127\.0\.0\.1|ECONN|protocol/i);

  // and when the scanner is back, the same upload works
  clamd.behaviour = 'normal';
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file('later.pdf', await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });

  expect(mon.problems.filter((p) => !/status of (422|503)/.test(p))).toEqual([]);
  expect(await mon.cspViolations()).toEqual([]);
});
