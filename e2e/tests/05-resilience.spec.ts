import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { file, makePdf } from '../support/helpers';
import { killWorker, readState, startWorker } from '../support/stack';

const pdftoppmCount = () => Number(execFileSync('sh', ['-c', 'ps -eo cmd | grep -c "[p]dftoppm" || true']).toString().trim());

test('a worker crash mid-job: the user gets a clear error, no orphaned engines are left running, and retry works once a worker is back', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/pdf-to-images');
  // Must still be running when we look for the engine, on any machine: few pages, each huge (1600pt at 300 DPI = ~44 megapixels),
  // rather than many small ones that a fast machine can finish before the first poll.
  await page.setInputFiles('input[type=file]', file('long.pdf', await makePdf(40, { w: 1600, h: 1600 })));
  await page.getByLabel('Resolution (DPI)').fill('300');
  await page.getByRole('button', { name: 'PDF to JPG / PNG' }).click();
  await expect(page.getByText(/Processing…/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(pdftoppmCount, { timeout: 15_000 }).toBeGreaterThan(0); // the engine is really running

  killWorker(); // SIGKILL the whole worker, simulating a crash/OOM-kill
  // the job process notices its parent died and takes its engines down with it
  await expect.poll(pdftoppmCount, { timeout: 15_000, message: 'orphaned pdftoppm still running after worker death' }).toBe(0);
  // the reaper notices the missing heartbeat (6 s in this stack) and fails the job with an honest message
  await expect(page.getByRole('alert')).toContainText(/interrupted/i, { timeout: 40_000 });

  startWorker();
  await page.getByLabel('Resolution (DPI)').fill('72');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible({ timeout: 60_000 });
  expect(readState().pids.worker).toBeGreaterThan(0);
});

test('results survive an API process restart (job state lives in MongoDB, files on disk)', async ({ page }) => {
  await page.goto('/rotate');
  await page.setInputFiles('input[type=file]', file('persist.pdf', await makePdf(1)));
  await page.getByRole('button', { name: 'Rotate PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Your file is ready' })).toBeVisible();
  const s = readState();
  process.kill(-s.pids.api, 'SIGTERM');
  // The API now shuts down gracefully (reports "draining" on /ready, keeps serving briefly, then exits). A new instance cannot
  // bind the port until the old one is gone, exactly as with a real orchestrator, so wait for that before starting the next.
  await expect.poll(async () => fetch(`${s.apiUrl}/ready`).then(async (r) => ((await r.json()) as { status: string }).status, () => 'gone'), { timeout: 4000, message: 'readiness must report draining right after SIGTERM' }).toBe('draining');
  await expect.poll(async () => fetch(`${s.apiUrl}/health`).then(() => 'up', () => 'down'), { timeout: 30_000, message: 'old API never finished draining' }).toBe('down');
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const { ROOT } = await import('../support/stack');
  // Keep logging to the stack's API log: later tests read emailed links from it, and a silent replacement would hand them stale ones.
  const { openSync } = await import('node:fs');
  const log = openSync(s.apiLog, 'a');
  const api = spawn(process.execPath, [join(ROOT, 'apps/api/dist/server.js')], { cwd: join(ROOT, 'apps/api'), env: { ...s.env, PATH: process.env.PATH ?? '' }, stdio: ['ignore', log, log], detached: true });
  api.unref();
  await expect.poll(async () => (await fetch(`${s.apiUrl}/health`).catch(() => ({ ok: false }))).ok, { timeout: 30_000 }).toBe(true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]); // same guest cookie, same job
  expect(dl.suggestedFilename()).toBe('persist-rotated.pdf');
  // keep later specs' state file accurate
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(ROOT, 'e2e/.stack.json'), JSON.stringify({ ...readState(), pids: { ...readState().pids, api: api.pid! } }, null, 2));
});
